import assert from "node:assert/strict"
import { test } from "node:test"
import { Session } from "@openbot-build/core"
import { RequestsApi, SessionView, WorkflowsApi } from "@openbot-build/api"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { Effect, Redacted, Result, Schema, Stream } from "effect"
import { LanguageModel, type Prompt, Response } from "effect/ai"
import { workflows } from "../src/database/Schema.ts"
import { names } from "../src/plugins/workflows/WorkflowPlugin.ts"
import * as Templates from "../src/workflows/Templates.ts"
import * as BrowserHost from "./BrowserHost.ts"
import { withCookie, withToken } from "./Caller.ts"

const publicOrigin = "https://workflows.example.com"
const usage = {
	inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}

const textOf = (message: Prompt.Message) =>
	typeof message.content === "string"
		? message.content
		: message.content
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("")

const answer = (text: string) =>
	Stream.make(
		Response.makePart("text-start", { id: "answer" }),
		Response.makePart("text-delta", { id: "answer", delta: text }),
		Response.makePart("text-end", { id: "answer" }),
		Response.makePart("finish", { reason: "stop", usage }),
	)
let calls = 0
const call = (name: string, params: Record<string, unknown>) =>
	Stream.make(
		Response.makePart("tool-call", {
			id: "call-" + calls++,
			name,
			params,
			providerExecuted: false,
		}),
		Response.makePart("finish", { reason: "tool-calls", usage }),
	)

/** How many model steps worked on act steps. A replayed step needs none. */
let actSteps = 0
/** The Workflow that the Main Agent runs when a person asks it to. */
const known: { workflow?: string } = {}

/**
 * One scripted model for every step. It reads the step from the last message:
 * "Goal: set <key> to <value>", "Condition: <key> is <value>" and "Find this value: <key>".
 */
const model = Effect.runSync(
	LanguageModel.make({
		generateText: () =>
			Effect.succeed([Response.makePart("text", { text: '{"changes":[]}' })]),
		streamText: ({ prompt }) =>
			Stream.suspend((): Stream.Stream<Response.StreamPartEncoded> => {
				const last = prompt.content.findLastIndex(
					(message) => message.role === "user",
				)
				const input = textOf(prompt.content[last]!)
				const results = prompt.content
					.slice(last + 1)
					.flatMap((message) =>
						message.role === "tool"
							? message.content.filter((part) => part.type === "tool-result")
							: [],
					)
				const result = (name: string) =>
					results.filter((part) => part.name === name).at(-1)
				if (input.includes(": act.")) {
					actSteps++
					const goal = /Goal: set (\S+) to (\S+)/.exec(input)!
					const set = result("SetValue")
					if (set === undefined)
						return call("SetValue", {
							key: goal[1],
							value: goal[2],
							// After a replay that did not work, the Agent forces the change.
							...(input.includes("did not work") ? { force: true } : {}),
						})
					if (result(names.stepResult) === undefined)
						return call(names.stepResult, {
							status: set.isFailure ? "failed" : "done",
							summary: "Set " + goal[1],
						})
					return answer("Done.")
				}
				if (input.includes(": check.")) {
					const condition = /Condition: (\S+) is (\S+)/.exec(input)!
					const read = result("GetValue")
					if (read === undefined) return call("GetValue", { key: condition[1] })
					if (result(names.check) === undefined) {
						const value = (read.result as { value: string | null }).value
						return call(names.check, {
							passed: value === condition[2],
							evidence: `${condition[1]} is ${value}`,
						})
					}
					return answer("Checked.")
				}
				if (input.includes(": extract.")) {
					const key = /Find this value: (\S+)/.exec(input)![1]!
					const read = result("GetValue")
					if (read === undefined) return call("GetValue", { key })
					if (result(names.extract) === undefined)
						return call(names.extract, {
							value: (read.result as { value: string | null }).value,
						})
					return answer("Extracted.")
				}
				if (input.includes(": explore.")) {
					if (result(names.finding) === undefined)
						return call(names.finding, {
							severity: "high",
							title: "The door has no lock",
							expected: "The door can be locked",
							observed: "There is no lock",
							reproduction: ["Open the door", "Look for a lock"],
						})
					if (result(names.stepResult) === undefined)
						return call(names.stepResult, {
							status: "done",
							summary: "Found one problem.",
						})
					return answer("Explored.")
				}
				if (input.includes("run the workflow")) {
					if (result(names.run) === undefined)
						return call(names.run, {
							workflow: known.workflow,
							reason: "The person asked for it.",
							input: { color: "green" },
						})
					return answer("Started.")
				}
				return answer("Noted.")
			}),
	}),
)

const client = (host: Awaited<ReturnType<typeof BrowserHost.start>>) => {
	const send = withCookie({ address: host.address, publicOrigin })
	const json = async <A, I>(
		schema: Schema.Codec<A, I>,
		response: Promise<globalThis.Response>,
		status?: number,
	): Promise<A> => {
		const value = await response
		const body = await value.text()
		if (status === undefined) assert.ok(value.ok, value.status + " " + body)
		else assert.equal(value.status, status, body)
		return Schema.decodeUnknownSync(schema)(JSON.parse(body))
	}
	const pause = () => new Promise((resolve) => setTimeout(resolve, 25))
	const until = async <A>(
		label: string,
		check: () => Promise<A | undefined>,
	): Promise<A> => {
		for (let tries = 0; tries < 800; tries++) {
			const value = await check()
			if (value !== undefined) return value
			await pause()
		}
		throw new Error("Timed out: " + label)
	}
	/** Waits until a Run has ended. */
	const ended = (credential: Redacted.Redacted<string>, run: string) =>
		until("the Run ends", async () => {
			const current = await json(
				WorkflowsApi.Run,
				send(credential, "/v1/workflow-runs/" + run),
			)
			return current.status === "passed" ||
				current.status === "failed" ||
				current.status === "cancelled"
				? current
				: undefined
		})
	return { send, json, until, ended }
}

const step = (run: WorkflowsApi.Run, id: string) =>
	run.steps.find((entry) => entry.id === id)!

test("templates fill in values and Expect compares them", () => {
	const scope: Templates.Scope = {
		input: { mode: "fast", count: 3 },
		vars: { color: "blue" },
		steps: { first: { output: { value: "ok" } } },
	}
	assert.deepEqual(
		Templates.text(
			"{{input.mode}} {{ vars.color }} {{steps.first.output.value}}",
			scope,
		),
		Result.succeed("fast blue ok"),
	)
	assert.deepEqual(
		Templates.json({ n: "{{input.count}}", text: "n={{input.count}}" }, scope),
		Result.succeed({ n: 3, text: "n=3" }),
	)
	assert.ok(Result.isFailure(Templates.text("{{input.missing}}", scope)))
	assert.ok(Result.isFailure(Templates.text("{{other.value}}", scope)))
	const expect = (
		operator: "equals" | "contains" | "matches" | "not_empty",
		value: string,
		expected?: string,
	) =>
		Templates.expect(
			{
				_tag: "Expect",
				id: WorkflowsApi.StepId.make("check"),
				value,
				operator,
				...(expected === undefined ? {} : { expected }),
			},
			scope,
		)
	assert.ok(Result.isSuccess(expect("equals", "{{vars.color}}", "blue")))
	assert.ok(Result.isFailure(expect("equals", "{{vars.color}}", "red")))
	assert.ok(
		Result.isSuccess(expect("contains", "a {{vars.color}} door", "blue")),
	)
	assert.ok(Result.isSuccess(expect("matches", "{{input.count}}", "^[0-9]+$")))
	assert.ok(Result.isFailure(expect("matches", "x", "(")))
	assert.ok(Result.isFailure(expect("not_empty", " ")))
})

test(
	"a Workflow mixes exact steps with Agent steps, and replays a checked act step without the model",
	{ timeout: 180000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, model })
		try {
			const { send, json, ended } = client(host)
			const alice = await host.login("workflows-alice")
			const bob = await host.login("workflows-bob")
			const created = await json(
				WorkflowsApi.Workflow,
				send(alice.session, "/v1/workflows", "POST", {
					name: "Paint the door",
					steps: [
						{
							_tag: "Call",
							id: "set-mode",
							tool: "SetValue",
							arguments: { key: "mode", value: "{{input.mode}}" },
						},
						{
							_tag: "Expect",
							id: "mode-ok",
							value: "{{steps.set-mode.output.value}}",
							operator: "equals",
							expected: "{{input.mode}}",
						},
						{ _tag: "Act", id: "paint", goal: "set color to blue" },
						{ _tag: "Assert", id: "painted", condition: "color is blue" },
						{
							_tag: "Extract",
							id: "read",
							name: "color",
							instruction: "color",
							schema: { type: "string" },
						},
						{
							_tag: "Expect",
							id: "color-ok",
							value: "{{vars.color}}",
							operator: "equals",
							expected: "blue",
						},
					],
				}),
				201,
			)
			assert.equal(created.agent, null)
			// Another member cannot see a Workflow that is not shared.
			assert.equal(
				(await send(bob.session, "/v1/workflows/" + created.id)).status,
				404,
			)
			// Two steps with the same id are not a valid Workflow.
			const twice = await send(alice.session, "/v1/workflows", "POST", {
				name: "Twice",
				steps: [
					{ _tag: "Act", id: "same", goal: "set a to b" },
					{ _tag: "Act", id: "same", goal: "set a to c" },
				],
			})
			assert.equal(twice.status, 400)

			const start = (cache?: WorkflowsApi.CacheMode) =>
				json(
					WorkflowsApi.Run,
					send(alice.session, `/v1/workflows/${created.id}/runs`, "POST", {
						input: { mode: "fast" },
						...(cache === undefined ? {} : { cache }),
					}),
					202,
				)
			const first = await ended(alice.session, (await start()).id)
			assert.equal(first.status, "passed", JSON.stringify(first, null, 2))
			assert.deepEqual(
				first.steps.map((entry) => [entry.id, entry.status, entry.mode]),
				[
					["set-mode", "passed", "deterministic"],
					["mode-ok", "passed", "deterministic"],
					["paint", "passed", "live"],
					["painted", "passed", "live"],
					["read", "passed", "live"],
					["color-ok", "passed", "deterministic"],
				],
			)
			assert.deepEqual(first.variables, { color: "blue" })
			assert.equal(first.trigger, "manual")
			assert.equal(host.values.get("mode"), "fast")
			assert.equal(host.values.get("color"), "blue")
			assert.equal(first.sessions.length, 1)
			const workflowSession = await json(
				SessionView,
				send(alice.session, "/v1/sessions/" + first.sessions[0]!.session),
			)
			assert.equal(workflowSession.kind, "workflow")

			// The check after the act step confirmed its tool calls, so they are recorded.
			const recorded = await json(
				Schema.Array(WorkflowsApi.Recording),
				send(alice.session, `/v1/workflows/${created.id}/recordings`),
			)
			assert.deepEqual(recorded, [
				{
					step: "paint",
					calls: [
						{ tool: "SetValue", arguments: { key: "color", value: "blue" } },
					],
					verifiedAt: recorded[0]!.verifiedAt,
				},
			])

			// The next Run replays the recorded calls. The model does no act step.
			host.values.delete("color")
			const before = actSteps
			const second = await ended(alice.session, (await start()).id)
			assert.equal(second.status, "passed")
			assert.equal(step(second, "paint").mode, "replayed")
			assert.equal(actSteps, before)
			assert.equal(host.values.get("color"), "blue")
			assert.equal(second.summary.replayed, 1)

			// With the cache off, every step runs live.
			const third = await ended(alice.session, (await start("off")).id)
			assert.equal(step(third, "paint").mode, "live")
			assert.ok(actSteps > before)

			// The reports are for people, coding agents and CI.
			const markdown = await (
				await send(
					alice.session,
					`/v1/workflow-runs/${second.id}/report/markdown`,
				)
			).text()
			assert.match(markdown, /# Paint the door/)
			assert.match(markdown, /\| paint \| Act \| passed \| replayed \|/)
			const junit = await send(
				alice.session,
				`/v1/workflow-runs/${second.id}/report/junit`,
			)
			assert.match(junit.headers.get("content-type") ?? "", /xml/)
			assert.match(
				await junit.text(),
				/<testcase classname="Paint the door" name="paint"/,
			)

			// An API key works too, and a Run of another member is not visible.
			const token = await (
				await send(alice.session, "/v1/user/tokens", "POST", { name: "ci" })
			).json()
			const keyed = withToken(host.address)
			const byKey = await keyed(
				token.secret,
				`/v1/workflows/${created.id}/runs`,
				"POST",
				{ cache: "read" },
			)
			assert.equal(byKey.status, 202, await byKey.clone().text())
			const keyRun = await ended(
				alice.session,
				Schema.decodeUnknownSync(WorkflowsApi.Run)(await byKey.json()).id,
			)
			assert.equal(keyRun.cache, "read")
			assert.equal(
				(await send(bob.session, "/v1/workflow-runs/" + keyRun.id)).status,
				404,
			)
			const listed = await json(
				Schema.Array(WorkflowsApi.Run),
				keyed(token.secret, `/v1/workflow-runs?workflow=${created.id}`),
			)
			assert.equal(listed.length, 4)
		} finally {
			await host.close()
		}
	},
)

test(
	"a replay that does not work goes to the Agent, a failed check stops the Run, and triggers start Runs",
	{ timeout: 240000 },
	async () => {
		const host = await BrowserHost.start({
			publicOrigin,
			model,
			workflowIntervalMs: 200,
		})
		try {
			const { send, json, until, ended } = client(host)
			const alice = await host.login("triggers-alice")
			const door = await json(
				WorkflowsApi.Workflow,
				send(alice.session, "/v1/workflows", "POST", {
					name: "Open the door",
					steps: [
						{ _tag: "Act", id: "open", goal: "set door to open" },
						{ _tag: "Assert", id: "opened", condition: "door is open" },
					],
				}),
				201,
			)
			const start = () =>
				json(
					WorkflowsApi.Run,
					send(alice.session, `/v1/workflows/${door.id}/runs`, "POST", {}),
					202,
				).then((run) => ended(alice.session, run.id))
			assert.equal((await start()).status, "passed")

			// The recorded call does not work any more, so the Agent finishes the goal.
			host.values.delete("door")
			host.locked.add("door")
			const handed = await start()
			assert.equal(handed.status, "passed", JSON.stringify(handed, null, 2))
			assert.equal(step(handed, "open").mode, "handed_off")
			assert.equal(host.values.get("door"), "open")
			const recorded = await json(
				Schema.Array(WorkflowsApi.Recording),
				send(alice.session, `/v1/workflows/${door.id}/recordings`),
			)
			assert.deepEqual(recorded[0]!.calls, [
				{
					tool: "SetValue",
					arguments: { key: "door", value: "open", force: true },
				},
			])
			host.locked.delete("door")

			// A check that fails stops the Run. The steps after it are skipped.
			const strict = await json(
				WorkflowsApi.Workflow,
				send(alice.session, "/v1/workflows", "POST", {
					name: "Closed door",
					steps: [
						{ _tag: "Assert", id: "closed", condition: "door is closed" },
						{ _tag: "Act", id: "never", goal: "set door to painted" },
					],
				}),
				201,
			)
			const failed = await ended(
				alice.session,
				(
					await json(
						WorkflowsApi.Run,
						send(alice.session, `/v1/workflows/${strict.id}/runs`, "POST", {}),
						202,
					)
				).id,
			)
			assert.equal(failed.status, "failed")
			assert.deepEqual(
				failed.steps.map((entry) => entry.status),
				["failed", "skipped"],
			)
			assert.equal(step(failed, "closed").message, "door is open")

			// An exploration plans its own steps and reports what it finds.
			const explored = await ended(
				alice.session,
				(
					await json(
						WorkflowsApi.Run,
						send(alice.session, "/v1/explorations", "POST", {
							goal: "look for problems with the door",
						}),
						202,
					)
				).id,
			)
			assert.equal(explored.status, "passed")
			assert.equal(explored.workflow, null)
			assert.deepEqual(
				explored.findings.map((finding) => [finding.severity, finding.title]),
				[["high", "The door has no lock"]],
			)

			// A webhook starts a Run with its body as input. A wrong secret does nothing.
			const hook = await json(
				WorkflowsApi.WebhookSecret,
				send(alice.session, `/v1/workflows/${door.id}/webhook`, "PUT"),
			)
			assert.equal(hook.url, publicOrigin + "/v1/hooks/workflows/" + door.id)
			const trigger = (secret: string) =>
				fetch(host.address + "/v1/hooks/workflows/" + door.id, {
					method: "POST",
					headers: {
						authorization: "Bearer " + secret,
						"content-type": "application/json",
					},
					body: JSON.stringify({ from: "ci" }),
				})
			assert.equal((await trigger("owh_wrong")).status, 401)
			const hooked = await trigger(hook.secret)
			assert.equal(hooked.status, 202, await hooked.clone().text())
			const hookRun = await ended(
				alice.session,
				((await hooked.json()) as { run: string }).run,
			)
			assert.equal(hookRun.trigger, "webhook")
			assert.deepEqual(hookRun.input, { from: "ci" })
			assert.equal(hookRun.status, "passed")

			// A schedule starts a Run when its time comes.
			const scheduled = await json(
				WorkflowsApi.Workflow,
				send(alice.session, `/v1/workflows/${door.id}`, "PATCH", {
					expected: (
						await json(
							WorkflowsApi.Workflow,
							send(alice.session, `/v1/workflows/${door.id}`),
						)
					).revision,
					schedule: { cron: "0 9 * * *", timeZone: "Europe/Berlin" },
				}),
			)
			assert.equal(scheduled.actor, alice.identity.userId)
			const badCron = await send(
				alice.session,
				`/v1/workflows/${door.id}`,
				"PATCH",
				{
					expected: scheduled.revision,
					schedule: { cron: "not a cron" },
				},
			)
			assert.equal(badCron.status, 400)
			// Make the schedule due now, as if 9 o'clock had come.
			await host.runtime.runPromise(
				Effect.flatMap(makeWithDefaults(), (db) =>
					db.update(workflows).set({ nextRunAt: 0 }),
				),
			)
			const scheduledRun = await until("a scheduled Run", async () => {
				const list = await json(
					Schema.Array(WorkflowsApi.Run),
					send(alice.session, `/v1/workflow-runs?workflow=${door.id}`),
				)
				return list.find((run) => run.trigger === "schedule")
			})
			assert.equal(
				(await ended(alice.session, scheduledRun.id)).status,
				"passed",
			)

			// A long wait can be cancelled.
			const waiting = await json(
				WorkflowsApi.Workflow,
				send(alice.session, "/v1/workflows", "POST", {
					name: "Wait for paint",
					steps: [
						{
							_tag: "WaitFor",
							id: "dry",
							condition: "paint is dry",
							timeoutSeconds: 600,
							intervalSeconds: 1,
						},
					],
				}),
				201,
			)
			const long = await json(
				WorkflowsApi.Run,
				send(alice.session, `/v1/workflows/${waiting.id}/runs`, "POST", {}),
				202,
			)
			await until("the wait checks twice", async () => {
				const current = await json(
					WorkflowsApi.Run,
					send(alice.session, "/v1/workflow-runs/" + long.id),
				)
				return step(current, "dry").attempts >= 2 ? current : undefined
			})
			const cancelled = await json(
				WorkflowsApi.Run,
				send(alice.session, `/v1/workflow-runs/${long.id}/cancel`, "POST"),
			)
			assert.equal(cancelled.status, "cancelled")
			assert.equal(step(cancelled, "dry").status, "skipped")

			// The Main Agent runs a Workflow after the person allows it. The result comes back as a message.
			known.workflow = door.id
			const session = await json(
				SessionView,
				send(alice.session, "/v1/sessions", "POST", {}),
			)
			const path = "/v1/sessions/" + session.session.id
			const turn = await send(alice.session, path + "/turns", "POST", {
				expected: session.session.revision,
				input: "run the workflow",
			})
			assert.equal(turn.status, 202, await turn.clone().text())
			const request = await until("a pending request", async () => {
				const list = await json(
					Schema.Array(RequestsApi.CapabilityRequest),
					send(alice.session, "/v1/requests?status=pending"),
				)
				return list[0]
			})
			assert.deepEqual(request.capability, {
				action: "workflows.run",
				target: door.id,
			})
			await json(
				RequestsApi.CapabilityRequest,
				send(alice.session, "/v1/requests/" + request.id, "POST", {
					expected: request.revision,
					decision: "allow",
					scope: "once",
				}),
			)
			const byAgent = await until("a Run of the Agent", async () => {
				const list = await json(
					Schema.Array(WorkflowsApi.Run),
					send(alice.session, `/v1/workflow-runs?workflow=${door.id}`),
				)
				return list.find((run) => run.trigger === "agent")
			})
			assert.deepEqual(byAgent.input, { color: "green" })
			assert.equal((await ended(alice.session, byAgent.id)).status, "passed")
			await until("the result comes back to the Session", async () => {
				const history = await (
					await send(alice.session, path + "/history")
				).text()
				return history.includes(`The Workflow Run ${byAgent.id}`)
					? true
					: undefined
			})
			const view = await json(SessionView, send(alice.session, path))
			assert.notEqual(Session.status(view.session)._tag, "Failed")
		} finally {
			await host.close()
		}
	},
)

test(
	"a Run that waits for approval goes on after a restart",
	{ timeout: 180000 },
	async () => {
		const host = await BrowserHost.start({
			publicOrigin,
			model,
			workflowIntervalMs: 200,
		})
		try {
			const { send, json, until } = client(host)
			const alice = await host.login("restart-alice")
			const confirm = await json(
				WorkflowsApi.Workflow,
				send(alice.session, "/v1/workflows", "POST", {
					name: "Confirm a change",
					steps: [
						{
							_tag: "Call",
							id: "confirm",
							tool: "ConfirmChange",
							arguments: { description: "new sign" },
						},
						{
							_tag: "Expect",
							id: "applied",
							value: "{{steps.confirm.output.applied}}",
							operator: "equals",
							expected: "new sign",
						},
					],
				}),
				201,
			)
			const run = await json(
				WorkflowsApi.Run,
				send(alice.session, `/v1/workflows/${confirm.id}/runs`, "POST", {}),
				202,
			)
			const request = await until("a pending request", async () => {
				const list = await json(
					Schema.Array(RequestsApi.CapabilityRequest),
					send(alice.session, "/v1/requests?status=pending"),
				)
				return list[0]
			})
			assert.deepEqual(request.capability, {
				action: "tools.call",
				target: "ConfirmChange",
			})
			assert.equal(host.toolCalls(), 0)

			await host.restart()
			// The server has a new address after the restart.
			const after = client(host)

			await after.json(
				RequestsApi.CapabilityRequest,
				after.send(alice.session, "/v1/requests/" + request.id, "POST", {
					expected: request.revision,
					decision: "allow",
					scope: "once",
				}),
			)
			const done = await after.ended(alice.session, run.id)
			assert.equal(done.status, "passed", JSON.stringify(done, null, 2))
			assert.equal(host.toolCalls(), 1)
			assert.deepEqual(step(done, "confirm").output, { applied: "new sign" })
		} finally {
			await host.close()
		}
	},
)
