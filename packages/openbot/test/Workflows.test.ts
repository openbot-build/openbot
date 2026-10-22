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

/** How many model steps worked on task nodes. A replayed node needs none. */
let taskSteps = 0
/** How many model steps wrote plans. A plan that passed before needs none. */
let planSteps = 0
/** The Workflow that the Main Agent runs when a person asks it to. */
const known: { workflow?: string; plan?: string } = {}

/** A plan with one task that sets a value, and a check that the value is right. */
const planFor = (key: string, value: string) => [
	{ _tag: "Task", id: "do", goal: `set ${key} to ${value}` },
	{
		_tag: "Check",
		id: "verify",
		needs: ["do"],
		condition: `${key} is ${value}`,
	},
]

/**
 * One scripted model for every node. It reads the node from the last message:
 * "Goal: set <key> to <value>", "Condition: <key> is <value>", and plans for
 * "Goal: set ..." and "Goal: make <key> <value>". The first plan for "make" is wrong on purpose.
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
				if (input.includes(": task.")) {
					taskSteps++
					const goal = /Goal: set (\S+) to (\S+)/.exec(input)!
					const set = result("SetValue")
					if (set === undefined)
						return call("SetValue", {
							key: goal[1],
							value: goal[2],
							// After a replay that did not work, the Agent forces the change.
							...(input.includes("did not work") ? { force: true } : {}),
						})
					if (result(names.nodeResult) === undefined)
						return call(names.nodeResult, {
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
							...(input.includes("Also give the value") ? { value } : {}),
						})
					}
					return answer("Checked.")
				}
				if (input.includes(": plan.")) {
					if (result(names.plan) !== undefined) return answer("Planned.")
					planSteps++
					const set = /Goal: set (\S+) to (\S+)/.exec(input)
					const make = /Goal: make (\S+) (\S+)/.exec(input)
					const nodes =
						set !== null
							? planFor(set[1]!, set[2]!)
							: planFor(
									make![1]!,
									input.includes("did not reach") ? make![2]! : "wrong",
								)
					return call(names.plan, { name: "A plan", nodes })
				}
				if (input.includes("plan the lamp")) {
					if (result(names.plan) !== undefined) return answer("Planned.")
					const again = input.includes("again")
					return call(names.plan, {
						name: "Lamp",
						...(again ? { workflow: known.plan } : {}),
						nodes: [
							{ _tag: "Task", id: "lamp-on", goal: "set lamp to on" },
							...(again
								? [
										{
											_tag: "Expect",
											id: "lamp-ok",
											needs: ["lamp-on"],
											value: "{{nodes.lamp-on.output}}",
											operator: "not_empty",
										},
									]
								: []),
						],
					})
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

const node = (run: WorkflowsApi.Run, id: string) =>
	run.nodes.find((entry) => entry.id === id)!

test("templates fill in values and conditions compare them", () => {
	const scope: Templates.Scope = {
		input: { mode: "fast", count: 3 },
		nodes: { first: { output: { value: "ok" } } },
	}
	assert.deepEqual(
		Templates.text("{{input.mode}} {{ nodes.first.output.value }}", scope),
		Result.succeed("fast ok"),
	)
	assert.deepEqual(
		Templates.json({ n: "{{input.count}}", text: "n={{input.count}}" }, scope),
		Result.succeed({ n: 3, text: "n=3" }),
	)
	assert.ok(Result.isFailure(Templates.text("{{input.missing}}", scope)))
	assert.ok(Result.isFailure(Templates.text("{{steps.first.output}}", scope)))
	const expect = (
		operator: "equals" | "contains" | "matches" | "not_empty",
		value: string,
		expected?: string,
	) =>
		Templates.expect(
			{ value, operator, ...(expected === undefined ? {} : { expected }) },
			scope,
		)
	assert.ok(Result.isSuccess(expect("equals", "{{input.mode}}", "fast")))
	assert.ok(Result.isFailure(expect("equals", "{{input.mode}}", "slow")))
	assert.ok(
		Result.isSuccess(expect("contains", "a {{input.mode}} car", "fast")),
	)
	assert.ok(Result.isSuccess(expect("matches", "{{input.count}}", "^[0-9]+$")))
	assert.ok(Result.isFailure(expect("matches", "x", "(")))
	assert.ok(Result.isFailure(expect("not_empty", " ")))
	// A false condition is an answer. A condition that cannot be checked is a failure.
	assert.deepEqual(
		Templates.condition(
			{ value: "a", operator: "equals", expected: "b" },
			scope,
		).pipe(Result.map((checked) => checked.passed)),
		Result.succeed(false),
	)
	assert.ok(
		Result.isFailure(
			Templates.condition(
				{ value: "{{nodes.none.output}}", operator: "not_empty" },
				scope,
			),
		),
	)
})

test(
	"a Workflow graph runs nodes at the same time, follows needs, when and onFail, and replays checked tasks",
	{ timeout: 180000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, model })
		try {
			const { send, json, ended } = client(host)
			const alice = await host.login("graph-alice")
			const bob = await host.login("graph-bob")
			const created = await json(
				WorkflowsApi.Workflow,
				send(alice.session, "/v1/workflows", "POST", {
					name: "Paint the door",
					graph: {
						nodes: [
							{
								_tag: "Call",
								id: "set-mode",
								tool: "SetValue",
								arguments: { key: "mode", value: "{{input.mode}}" },
							},
							{
								_tag: "Task",
								id: "paint",
								needs: ["set-mode"],
								goal: "set color to blue",
							},
							{
								_tag: "Task",
								id: "size",
								needs: ["set-mode"],
								goal: "set size to big",
								check: "size is big",
							},
							{
								_tag: "Check",
								id: "painted",
								needs: ["paint"],
								condition: "color is blue",
								output: { type: "string" },
							},
							{
								_tag: "Check",
								id: "closed",
								condition: "door is closed",
								onFail: "continue",
							},
							{
								_tag: "Task",
								id: "slow",
								when: {
									value: "{{input.mode}}",
									operator: "equals",
									expected: "slow",
								},
								goal: "set speed to slow",
							},
							{
								_tag: "Expect",
								id: "join",
								needs: ["painted", "size", "slow"],
								value: "{{nodes.painted.output}}",
								operator: "equals",
								expected: "blue",
							},
						],
					},
				}),
				201,
			)
			assert.equal(created.agent, null)
			assert.equal(created.origin, null)
			// Another member cannot see a Workflow that is not shared.
			assert.equal(
				(await send(bob.session, "/v1/workflows/" + created.id)).status,
				404,
			)
			// A graph must have unique ids, known needs, and no circle.
			const invalid = async (nodes: ReadonlyArray<unknown>) =>
				assert.equal(
					(
						await send(alice.session, "/v1/workflows", "POST", {
							name: "Broken",
							graph: { nodes },
						})
					).status,
					400,
				)
			await invalid([
				{ _tag: "Task", id: "same", goal: "set a to b" },
				{ _tag: "Task", id: "same", goal: "set a to c" },
			])
			await invalid([
				{ _tag: "Task", id: "a", needs: ["none"], goal: "set a to b" },
			])
			await invalid([
				{ _tag: "Task", id: "a", needs: ["b"], goal: "set a to b" },
				{ _tag: "Task", id: "b", needs: ["a"], goal: "set b to a" },
			])

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
				first.nodes.map((entry) => [entry.id, entry.status, entry.mode]),
				[
					["set-mode", "passed", "deterministic"],
					["paint", "passed", "live"],
					["size", "passed", "live"],
					["painted", "passed", "live"],
					["closed", "failed", "live"],
					["slow", "skipped", null],
					["join", "passed", "deterministic"],
				],
			)
			assert.equal(node(first, "painted").output, "blue")
			assert.deepEqual(node(first, "join").needs, ["painted", "size", "slow"])
			assert.equal(host.values.get("mode"), "fast")
			assert.equal(host.values.get("color"), "blue")
			assert.equal(host.values.get("speed"), undefined)
			assert.ok(first.usage.tokens > 0)
			// paint and size ran at the same time, so they worked in two Sessions.
			assert.ok(first.sessions.length >= 2, JSON.stringify(first.sessions))
			const workflowSession = await json(
				SessionView,
				send(alice.session, "/v1/sessions/" + first.sessions[0]!.session),
			)
			assert.equal(workflowSession.kind, "workflow")

			// The checks after the tasks confirmed their tool calls, so they are recorded.
			const recorded = await json(
				Schema.Array(WorkflowsApi.Recording),
				send(alice.session, `/v1/workflows/${created.id}/recordings`),
			)
			assert.deepEqual(
				recorded.map((entry) => [entry.node, entry.calls]),
				[
					[
						"paint",
						[{ tool: "SetValue", arguments: { key: "color", value: "blue" } }],
					],
					[
						"size",
						[{ tool: "SetValue", arguments: { key: "size", value: "big" } }],
					],
				],
			)

			// The next Run replays the recorded calls. The model does no task.
			host.values.delete("color")
			host.values.delete("size")
			const before = taskSteps
			const second = await ended(alice.session, (await start()).id)
			assert.equal(second.status, "passed")
			assert.equal(node(second, "paint").mode, "replayed")
			assert.equal(node(second, "size").mode, "replayed")
			assert.equal(taskSteps, before)
			assert.equal(host.values.get("color"), "blue")
			assert.equal(second.summary.replayed, 2)

			// With the cache off, every node runs live.
			const third = await ended(alice.session, (await start("off")).id)
			assert.equal(node(third, "paint").mode, "live")
			assert.ok(taskSteps > before)

			// The reports are for people, coding agents and CI.
			const markdown = await (
				await send(
					alice.session,
					`/v1/workflow-runs/${second.id}/report/markdown`,
				)
			).text()
			assert.match(markdown, /# Paint the door/)
			assert.match(
				markdown,
				/\| paint \| Task \| set-mode \| passed \| replayed \|/,
			)
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
	"a Plan node writes a Workflow graph, a Goal node plans again until its check passes, and a plan that passed runs again without a model",
	{ timeout: 240000 },
	async () => {
		const host = await BrowserHost.start({
			publicOrigin,
			model,
			workflowIntervalMs: 200,
		})
		try {
			const { send, json, until, ended } = client(host)
			const alice = await host.login("plans-alice")
			const workflow = await json(
				WorkflowsApi.Workflow,
				send(alice.session, "/v1/workflows", "POST", {
					name: "Plan the house",
					graph: {
						nodes: [
							{ _tag: "Plan", id: "door", goal: "set door to open" },
							{
								_tag: "Goal",
								id: "color",
								needs: ["door"],
								goal: "make color blue",
								check: "color is blue",
								budget: { tokens: 1 },
							},
						],
					},
				}),
				201,
			)
			const started = await json(
				WorkflowsApi.Run,
				send(alice.session, `/v1/workflows/${workflow.id}/runs`, "POST", {}),
				202,
			)
			// The first plan of the Goal is wrong, so it must plan again. It used its budget,
			// so the person must agree that it goes on.
			const request = await until("a budget request", async () => {
				const list = await json(
					Schema.Array(RequestsApi.CapabilityRequest),
					send(alice.session, "/v1/requests?status=pending"),
				)
				return list[0]
			})
			assert.deepEqual(request.capability, {
				action: "workflows.budget",
				target: workflow.id,
			})
			await json(
				RequestsApi.CapabilityRequest,
				send(alice.session, "/v1/requests/" + request.id, "POST", {
					expected: request.revision,
					decision: "allow",
					scope: "once",
				}),
			)
			const first = await ended(alice.session, started.id)
			assert.equal(first.status, "passed", JSON.stringify(first, null, 2))
			assert.equal(host.values.get("door"), "open")
			assert.equal(host.values.get("color"), "blue")
			assert.equal(node(first, "door").children.length, 1)
			assert.equal(node(first, "color").round, 1)
			assert.equal(node(first, "color").children.length, 2)

			// Each plan is a real Workflow of the Agent, kept apart from the normal list.
			const planned = await json(
				Schema.Array(WorkflowsApi.Workflow),
				send(alice.session, "/v1/workflows?planned=true"),
			)
			const doorPlan = planned.find(
				(entry) =>
					entry.origin?._tag === "Plan" && entry.origin.node === "door",
			)!
			assert.ok(doorPlan, JSON.stringify(planned))
			assert.equal(doorPlan.owner._tag, "Agent")
			assert.deepEqual(
				doorPlan.graph.nodes.map((entry) => [entry._tag, entry.id]),
				[
					["Task", "do"],
					["Check", "verify"],
				],
			)
			assert.equal(doorPlan.passedRevision, 0)
			const colorPlan = planned.find(
				(entry) =>
					entry.origin?._tag === "Plan" && entry.origin.node === "color",
			)!
			assert.equal(colorPlan.revision, 1)
			assert.equal(colorPlan.passedRevision, 1)
			const normal = await json(
				Schema.Array(WorkflowsApi.Workflow),
				send(alice.session, "/v1/workflows"),
			)
			assert.deepEqual(
				normal.map((entry) => entry.id),
				[workflow.id],
			)
			const child = await json(
				WorkflowsApi.Run,
				send(
					alice.session,
					"/v1/workflow-runs/" + node(first, "door").children[0],
				),
			)
			assert.equal(child.trigger, "plan")
			assert.deepEqual(child.parent, { run: first.id, node: "door" })

			// The next Run uses the plans that passed. No model writes a plan, and the tasks replay.
			host.values.delete("door")
			host.values.delete("color")
			const plans = planSteps
			const tasks = taskSteps
			const second = await ended(
				alice.session,
				(
					await json(
						WorkflowsApi.Run,
						send(
							alice.session,
							`/v1/workflows/${workflow.id}/runs`,
							"POST",
							{},
						),
						202,
					)
				).id,
			)
			assert.equal(second.status, "passed", JSON.stringify(second, null, 2))
			assert.equal(node(second, "door").mode, "replayed")
			assert.equal(node(second, "color").mode, "replayed")
			assert.equal(planSteps, plans)
			assert.equal(taskSteps, tasks)
			assert.equal(host.values.get("door"), "open")
			assert.equal(host.values.get("color"), "blue")
		} finally {
			await host.close()
		}
	},
)

test(
	"an Agent in a Session plans with a Workflow graph, and a new revision keeps the nodes that passed",
	{ timeout: 180000 },
	async () => {
		const host = await BrowserHost.start({
			publicOrigin,
			model,
			workflowIntervalMs: 200,
		})
		try {
			const { send, json, until, ended } = client(host)
			const alice = await host.login("session-plans-alice")
			const session = await json(
				SessionView,
				send(alice.session, "/v1/sessions", "POST", {}),
			)
			const path = "/v1/sessions/" + session.session.id
			// The end of a Run comes to the Session as a message, so the Session can change at any time.
			// A message that finds an old revision tries again.
			const say = (input: string) =>
				until("the Session takes the message", async () => {
					const view = await json(SessionView, send(alice.session, path))
					const status = Session.status(view.session)._tag
					if (status === "Running" || status === "Waiting") return undefined
					const turn = await send(alice.session, path + "/turns", "POST", {
						expected: view.session.revision,
						input,
					})
					if (turn.status === 409) return undefined
					assert.equal(turn.status, 202, await turn.clone().text())
					return true
				})
			await say("plan the lamp")
			const plan = await until("a plan of the Session", async () => {
				const list = await json(
					Schema.Array(WorkflowsApi.Workflow),
					send(alice.session, "/v1/workflows?planned=true"),
				)
				return list.find((entry) => entry.origin?._tag === "Session")
			})
			assert.deepEqual(plan.origin, {
				_tag: "Session",
				session: session.session.id,
			})
			const firstRun = await until("the Run of the plan", async () => {
				const list = await json(
					Schema.Array(WorkflowsApi.Run),
					send(alice.session, `/v1/workflow-runs?workflow=${plan.id}`),
				)
				return list[0]
			})
			assert.equal(firstRun.trigger, "agent")
			assert.equal((await ended(alice.session, firstRun.id)).status, "passed")
			assert.equal(host.values.get("lamp"), "on")
			await until("the result comes back to the Session", async () => {
				const history = await (
					await send(alice.session, path + "/history")
				).text()
				return history.includes(`The Workflow Run ${firstRun.id}`)
					? true
					: undefined
			})

			// A second plan with the same Workflow is a new revision. The task passed before,
			// and it did not change, so it keeps its result and does not run again.
			known.plan = plan.id
			const tasks = taskSteps
			await say("plan the lamp again")
			const secondRun = await until("a second Run of the plan", async () => {
				const list = await json(
					Schema.Array(WorkflowsApi.Run),
					send(alice.session, `/v1/workflow-runs?workflow=${plan.id}`),
				)
				return list.find((run) => run.id !== firstRun.id)
			})
			const second = await ended(alice.session, secondRun.id)
			assert.equal(second.status, "passed", JSON.stringify(second, null, 2))
			assert.equal(second.revision, 1)
			assert.deepEqual(
				second.nodes.map((entry) => [entry.id, entry.status]),
				[
					["lamp-on", "passed"],
					["lamp-ok", "passed"],
				],
			)
			assert.equal(taskSteps, tasks)
		} finally {
			await host.close()
		}
	},
)

test(
	"a replay that does not work goes to the Agent, a failed check stops the Run, child Runs stop with their parent, and triggers start Runs",
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
					graph: {
						nodes: [
							{ _tag: "Task", id: "open", goal: "set door to open" },
							{
								_tag: "Check",
								id: "opened",
								needs: ["open"],
								condition: "door is open",
							},
						],
					},
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
			assert.equal(node(handed, "open").mode, "handed_off")
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

			// A check that fails stops the Run. The nodes after it are skipped.
			const strict = await json(
				WorkflowsApi.Workflow,
				send(alice.session, "/v1/workflows", "POST", {
					name: "Closed door",
					graph: {
						nodes: [
							{ _tag: "Check", id: "closed", condition: "door is closed" },
							{
								_tag: "Task",
								id: "never",
								needs: ["closed"],
								goal: "set door to painted",
							},
						],
					},
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
				failed.nodes.map((entry) => entry.status),
				["failed", "skipped"],
			)
			assert.equal(node(failed, "closed").message, "door is open")

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

			// A Workflow node runs another Workflow as a child Run. A long wait in it can be cancelled,
			// and the child stops with its parent.
			const waiting = await json(
				WorkflowsApi.Workflow,
				send(alice.session, "/v1/workflows", "POST", {
					name: "Wait for paint",
					graph: {
						nodes: [
							{
								_tag: "Check",
								id: "dry",
								condition: "paint is dry",
								until: { timeoutSeconds: 600, intervalSeconds: 1 },
							},
						],
					},
				}),
				201,
			)
			const outer = await json(
				WorkflowsApi.Workflow,
				send(alice.session, "/v1/workflows", "POST", {
					name: "Paint and wait",
					graph: {
						nodes: [{ _tag: "Workflow", id: "wait", workflow: waiting.id }],
					},
				}),
				201,
			)
			const long = await json(
				WorkflowsApi.Run,
				send(alice.session, `/v1/workflows/${outer.id}/runs`, "POST", {}),
				202,
			)
			const inner = await until("the child waits twice", async () => {
				const current = await json(
					WorkflowsApi.Run,
					send(alice.session, "/v1/workflow-runs/" + long.id),
				)
				const childId = node(current, "wait").children[0]
				if (childId === undefined) return undefined
				const child = await json(
					WorkflowsApi.Run,
					send(alice.session, "/v1/workflow-runs/" + childId),
				)
				return node(child, "dry").attempts >= 1 &&
					node(child, "dry").turns.length >= 2
					? child
					: undefined
			})
			assert.equal(inner.trigger, "workflow")

			// A Run that goes on can move to a new revision of its Workflow.
			const revisedWaiting = await json(
				WorkflowsApi.Workflow,
				send(alice.session, `/v1/workflows/${waiting.id}`, "PATCH", {
					expected: waiting.revision,
					graph: {
						nodes: [
							{
								_tag: "Check",
								id: "dry",
								condition: "paint is dry",
								until: { timeoutSeconds: 600, intervalSeconds: 1 },
							},
							{ _tag: "Wait", id: "rest", needs: ["dry"], seconds: 1 },
						],
					},
				}),
			)
			const revised = await json(
				WorkflowsApi.Run,
				send(alice.session, `/v1/workflow-runs/${inner.id}/revise`, "POST", {}),
			)
			assert.equal(revised.revision, revisedWaiting.revision)
			assert.deepEqual(
				revised.nodes.map((entry) => [entry.id, entry.status]),
				[
					["dry", "running"],
					["rest", "pending"],
				],
			)

			const cancelled = await json(
				WorkflowsApi.Run,
				send(alice.session, `/v1/workflow-runs/${long.id}/cancel`, "POST"),
			)
			assert.equal(cancelled.status, "cancelled")
			assert.equal(node(cancelled, "wait").status, "skipped")
			assert.equal((await ended(alice.session, inner.id)).status, "cancelled")

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
					graph: {
						nodes: [
							{
								_tag: "Call",
								id: "confirm",
								tool: "ConfirmChange",
								arguments: { description: "new sign" },
							},
							{
								_tag: "Call",
								id: "mark",
								tool: "SetValue",
								arguments: { key: "sign", value: "ready" },
							},
							{
								_tag: "Expect",
								id: "applied",
								needs: ["confirm", "mark"],
								value: "{{nodes.confirm.output.applied}}",
								operator: "equals",
								expected: "new sign",
							},
						],
					},
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
			// The other branch does not wait for the approval.
			await until("the other branch ends", async () =>
				host.values.get("sign") === "ready" ? true : undefined,
			)

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
			assert.deepEqual(node(done, "confirm").output, { applied: "new sign" })
		} finally {
			await host.close()
		}
	},
)
