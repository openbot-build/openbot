import assert from "node:assert/strict"
import { test } from "node:test"
import { Session } from "@openbot-build/core"
import { AgentsApi, RequestsApi, SessionView } from "@openbot-build/api"
import * as AgentMemory from "../src/memory/AgentMemory.ts"
import { Effect, Redacted, Schema, Stream } from "effect"
import { LanguageModel, type Prompt, Response } from "effect/ai"
import { names } from "../src/agents/AgentPlugin.ts"
import * as BrowserHost from "./BrowserHost.ts"

const publicOrigin = "https://agents.example.com"
const usage = {
	inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}

/** Agent IDs that the scripted model needs. The test fills them in. */
const known: { programmer?: string; helper?: string } = {}

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

/**
 * One scripted model for every Agent. It reads the name of the Agent from its instructions,
 * and the task from the last user message.
 */
const model = Effect.runSync(
	LanguageModel.make({
		generateText: ({ prompt }) =>
			Effect.sync(() => {
				const system = prompt.content
					.filter((message) => message.role === "system")
					.map(textOf)
					.join("\n")
				// The judge allows when a Rule says that Main may confirm changes.
				if (
					system.includes("You decide one request of an AI Agent with Rules")
				) {
					const input = JSON.parse(textOf(prompt.content.at(-1)!)) as {
						rules: ReadonlyArray<{ id: string; text: string }>
					}
					const rule = input.rules.find((rule) =>
						rule.text.includes("Main may confirm changes"),
					)
					return [
						Response.makePart("text", {
							text: JSON.stringify(
								rule === undefined
									? {
											decision: "no_match",
											citations: [],
											explanation: "No Rule.",
										}
									: {
											decision: "allow",
											citations: [
												{ rule: rule.id, quote: "Main may confirm changes" },
											],
											explanation: "The Rule allows it.",
										},
							),
						}),
					]
				}
				return [Response.makePart("text", { text: '{"changes":[]}' })]
			}),
		streamText: ({ prompt }) =>
			Stream.suspend((): Stream.Stream<Response.StreamPartEncoded> => {
				const system = prompt.content
					.filter((message) => message.role === "system")
					.map(textOf)
					.join("\n")
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
				const has = (name: string) =>
					results.some((result) => result.name === name)
				if (system.includes("you decide one request")) {
					return has(names.approve)
						? answer("Decided.")
						: call(names.approve, {
								scope: "lifetime",
								reason: "It fits the task I gave.",
							})
				}
				const name = /You are (\w+)\./.exec(system)?.[1]
				if (name === "Programmer")
					return has(names.report)
						? answer("Reported.")
						: call(names.report, {
								status: "completed",
								summary: "Programmer did it",
							})
				if (name === "Helper") {
					if (!has("ConfirmChange"))
						return call("ConfirmChange", { description: "helper change" })
					return has(names.report)
						? answer("Reported.")
						: call(names.report, {
								status: "completed",
								summary: "Helper confirmed it",
							})
				}
				const done = results.at(-1)
				if (done !== undefined)
					return answer("Main got: " + JSON.stringify(done.result))
				if (input.includes("delegate to programmer"))
					return call(names.delegate, {
						agent: known.programmer,
						reason: "Code work needs the Programmer.",
						task: "Write the change.",
						userRequest: input,
						expectedOutput: "A short summary.",
					})
				if (input.includes("spawn a helper"))
					return call(names.spawn, {
						name: "Helper",
						role: "Confirms changes",
						instructions: "Confirm the change, then report.",
						reason: "This Session needs a helper.",
					})
				if (input.includes("confirm via helper"))
					return call(names.delegate, {
						agent: known.helper,
						reason: "The Helper confirms changes.",
						task: "Confirm the change.",
						userRequest: input,
						expectedOutput: "Whether it is confirmed.",
					})
				if (input.includes("confirm directly"))
					return call("ConfirmChange", { description: "main change" })
				return answer("Hello.")
			}),
	}),
)

const client = (host: Awaited<ReturnType<typeof BrowserHost.start>>) => {
	const send = (
		credential: Redacted.Redacted<string>,
		path: string,
		method = "GET",
		payload?: unknown,
	) =>
		fetch(host.address + path, {
			method,
			headers: {
				cookie:
					"__Host-openbot-session=" +
					encodeURIComponent(Redacted.value(credential)),
				origin: publicOrigin,
				...(payload === undefined
					? {}
					: { "content-type": "application/json" }),
			},
			...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
		})
	const json = async <A, I>(
		schema: Schema.Codec<A, I>,
		response: Promise<globalThis.Response>,
	): Promise<A> => {
		const value = await response
		const body = await value.text()
		assert.ok(value.ok, value.status + " " + body)
		return Schema.decodeUnknownSync(schema)(JSON.parse(body))
	}
	const pause = () => new Promise((resolve) => setTimeout(resolve, 25))
	/** Polls until the check returns a value. */
	const until = async <A>(
		label: string,
		check: () => Promise<A | undefined>,
	): Promise<A> => {
		for (let tries = 0; tries < 400; tries++) {
			const value = await check()
			if (value !== undefined) return value
			await pause()
		}
		throw new Error("Timed out: " + label)
	}
	return { send, json, until }
}

test(
	"a Main Agent gives work to a lasting Agent after the person allows it, and gets only the result back, also after a restart",
	{ timeout: 120000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, model })
		try {
			const { send, json, until } = client(host)
			const alice = await host.login("agents-alice")
			const bob = await host.login("agents-bob")
			const agents = await json(
				Schema.Array(AgentsApi.Agent),
				send(alice.session, "/v1/agents"),
			)
			const main = agents[0]!
			assert.equal(main.kind, "main")
			const programmer = await json(
				AgentsApi.Agent,
				send(alice.session, "/v1/agents", "POST", {
					name: "Programmer",
					role: "Writes code",
					instructions: "Write small changes.",
				}),
			)
			known.programmer = programmer.id
			assert.equal(
				(await send(bob.session, "/v1/agents/" + programmer.id)).status,
				404,
			)
			const created = await json(
				SessionView,
				send(alice.session, "/v1/sessions", "POST", {}),
			)
			assert.equal(created.agent, main.id)
			const path = "/v1/sessions/" + created.session.id
			const view = () => json(SessionView, send(alice.session, path))
			const turn = async (input: string) => {
				const current = await view()
				const started = await send(alice.session, path + "/turns", "POST", {
					expected: current.session.revision,
					input,
				})
				assert.equal(started.status, 202, await started.clone().text())
			}
			const completed = () =>
				until("the Turn completes", async () => {
					const current = await view()
					return Session.status(current.session)._tag === "Completed"
						? current
						: undefined
				})
			const pending = () =>
				until("a pending request", async () => {
					const list = await json(
						Schema.Array(RequestsApi.CapabilityRequest),
						send(alice.session, "/v1/requests?status=pending"),
					)
					return list[0]
				})

			await turn("delegate to programmer")
			const request = await pending()
			assert.deepEqual(request.capability, {
				action: "agents.delegate",
				target: programmer.id,
			})
			assert.deepEqual(request.approver, {
				_tag: "Person",
				userId: alice.identity.userId,
			})
			// The request is made inside the model step, just before the Turn saves that it waits.
			await until("the Turn waits", async () => {
				const current = await view()
				return Session.status(current.session)._tag === "Waiting"
					? current
					: undefined
			})
			const waiting = await json(
				Schema.Array(AgentsApi.Delegation),
				send(alice.session, path + "/delegations"),
			)
			assert.equal(waiting[0]?.status, "authorizing")

			// The wait is saved, so a restart does not lose it.
			await host.restart()
			const allowed = await json(
				RequestsApi.CapabilityRequest,
				send(alice.session, "/v1/requests/" + request.id, "POST", {
					expected: request.revision,
					decision: "allow",
					scope: "lifetime",
				}),
			)
			assert.equal(allowed.status, "allowed")
			const done = await completed()
			assert.match(JSON.stringify(done.response?.output), /Programmer did it/)
			const delegations = await json(
				Schema.Array(AgentsApi.Delegation),
				send(alice.session, path + "/delegations"),
			)
			assert.equal(delegations[0]?.status, "completed")
			assert.equal(delegations[0]?.result?.summary, "Programmer did it")
			const child = await json(
				SessionView,
				send(alice.session, "/v1/sessions/" + delegations[0]!.child!.session),
			)
			assert.equal(child.kind, "delegated")
			assert.equal(child.agent, programmer.id)
			assert.equal(child.parent?.session, created.session.id)
			// Only the result went back, never the history of the other Agent.
			assert.equal(
				JSON.stringify(done.state.value.conversation.history).includes(
					"Write the change.",
				),
				true,
			)
			assert.equal(
				JSON.stringify(done.state.value.conversation.history).includes(
					"Reported.",
				),
				false,
			)

			// The decision is kept as a Grant, so the second time needs no request.
			const grants = await json(
				Schema.Array(AgentsApi.Grant),
				send(alice.session, "/v1/agents/" + main.id + "/grants"),
			)
			assert.equal(grants.length, 1)
			assert.equal(grants[0]?.scope, "lifetime")
			await turn("delegate to programmer")
			await completed()
			const again = await json(
				Schema.Array(AgentsApi.Delegation),
				send(alice.session, path + "/delegations"),
			)
			assert.equal(
				again.filter((entry) => entry.status === "completed").length,
				2,
			)
			assert.deepEqual(
				await json(
					Schema.Array(RequestsApi.CapabilityRequest),
					send(alice.session, "/v1/requests?status=pending"),
				),
				[],
			)

			// A person can change Agent memory directly.
			const memory = await json(
				AgentMemory.State,
				send(alice.session, "/v1/agents/" + programmer.id + "/memory", "POST", {
					expected: 0,
					command: {
						_tag: "Remember",
						key: "tests-first",
						content: "Run the tests first.",
						kind: "procedure",
					},
				}),
			)
			assert.equal(memory.version, 1)
			assert.equal(
				(
					await send(
						alice.session,
						"/v1/agents/" + programmer.id + "/memory",
						"POST",
						{
							expected: 0,
							command: { _tag: "Forget", key: "tests-first" },
						},
					)
				).status,
				409,
			)
			const log = await json(
				Schema.Array(AgentMemory.LogEntry),
				send(alice.session, "/v1/agents/" + programmer.id + "/memory/log"),
			)
			assert.deepEqual(
				log.map((entry) => [entry.by, entry.keys]),
				[["person", ["tests-first"]]],
			)
		} finally {
			await host.close()
		}
	},
)

test(
	"a subagent asks, its owning Agent reviews and passes it up, and the person decides at the top",
	{ timeout: 120000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, model })
		try {
			const { send, json, until } = client(host)
			const alice = await host.login("agents-carol")
			const main = (
				await json(
					Schema.Array(AgentsApi.Agent),
					send(alice.session, "/v1/agents"),
				)
			)[0]!
			const created = await json(
				SessionView,
				send(alice.session, "/v1/sessions", "POST", {}),
			)
			const path = "/v1/sessions/" + created.session.id
			const view = () => json(SessionView, send(alice.session, path))
			const turn = async (input: string) => {
				const current = await view()
				const started = await send(alice.session, path + "/turns", "POST", {
					expected: current.session.revision,
					input,
				})
				assert.equal(started.status, 202, await started.clone().text())
			}
			const completed = () =>
				until("the Turn completes", async () => {
					const current = await view()
					return Session.status(current.session)._tag === "Completed"
						? current
						: undefined
				})
			const pendingFor = (
				check: (request: RequestsApi.CapabilityRequest) => boolean,
			) =>
				until("a pending request", async () =>
					(
						await json(
							Schema.Array(RequestsApi.CapabilityRequest),
							send(alice.session, "/v1/requests?status=pending"),
						)
					).find(check),
				)

			// Starting a subagent is a capability, so the person decides it first.
			await turn("spawn a helper")
			const spawn = await pendingFor(
				(request) => request.capability.action === "agents.spawn",
			)
			await json(
				RequestsApi.CapabilityRequest,
				send(alice.session, "/v1/requests/" + spawn.id, "POST", {
					expected: spawn.revision,
					decision: "allow",
				}),
			)
			await completed()
			const subagents = await json(
				Schema.Array(AgentsApi.Agent),
				send(alice.session, "/v1/agents?session=" + created.session.id),
			)
			assert.equal(subagents.length, 1)
			const helper = subagents[0]!
			assert.equal(helper.kind, "subagent")
			assert.deepEqual(helper.owner, {
				_tag: "Session",
				userId: alice.identity.userId,
				session: created.session.id,
			})
			known.helper = helper.id

			// The helper needs a tool. Main reviews it, cannot allow it alone, and passes it up.
			const toolsBefore = host.toolCalls()
			await turn("confirm via helper")
			const passedUp = await pendingFor(
				(request) =>
					request.capability.action === "tools.call" &&
					request.endorsements.length === 1,
			)
			assert.equal(passedUp.agent, helper.id)
			assert.deepEqual(passedUp.chain, [main.id, helper.id])
			assert.deepEqual(passedUp.endorsements[0], {
				agent: main.id,
				scope: "lifetime",
				reason: "It fits the task I gave.",
			})
			assert.equal(host.toolCalls(), toolsBefore)
			await json(
				RequestsApi.CapabilityRequest,
				send(alice.session, "/v1/requests/" + passedUp.id, "POST", {
					expected: passedUp.revision,
					decision: "allow",
					scope: "session",
				}),
			)
			const done = await completed()
			assert.match(JSON.stringify(done.response?.output), /Helper confirmed it/)
			assert.equal(host.toolCalls(), toolsBefore + 1)
			// Each Agent on the way got a Grant with the scope that its decider chose.
			const mainGrants = await json(
				Schema.Array(AgentsApi.Grant),
				send(alice.session, "/v1/agents/" + main.id + "/grants?status=active"),
			)
			const helperGrants = await json(
				Schema.Array(AgentsApi.Grant),
				send(
					alice.session,
					"/v1/agents/" + helper.id + "/grants?status=active",
				),
			)
			const mainTool = mainGrants.find(
				(grant) => grant.capability.action === "tools.call",
			)
			assert.equal(mainTool?.scope, "session")
			assert.equal(mainTool?.session, created.session.id)
			assert.equal(helperGrants[0]?.scope, "lifetime")
			assert.equal(helperGrants[0]?.parent, mainTool?.id)
			const reviews = await until("the review is archived", async () => {
				const list = await json(
					Schema.Array(Schema.Unknown),
					send(alice.session, "/v1/sessions?kind=review"),
				)
				return list.length > 0 ? list : undefined
			})
			assert.equal(reviews.length, 1)

			// Revoking the Grant of Main also revokes the Grant that it gave to the helper.
			const revoked = await send(
				alice.session,
				"/v1/agents/" + main.id + "/grants/" + mainTool!.id,
				"DELETE",
			)
			assert.equal(revoked.status, 204)
			assert.deepEqual(
				await json(
					Schema.Array(AgentsApi.Grant),
					send(
						alice.session,
						"/v1/agents/" + helper.id + "/grants?status=active",
					),
				),
				[],
			)

			// Deleting the Session archives its subagents.
			assert.equal((await send(alice.session, path, "DELETE")).status, 204)
			const after = await json(
				AgentsApi.Agent,
				send(alice.session, "/v1/agents/" + helper.id),
			)
			assert.equal(after.archived, true)
		} finally {
			await host.close()
		}
	},
)

test(
	"Rules let the judge allow a call, and a deny Grant wins over them",
	{ timeout: 120000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, model })
		try {
			const { send, json, until } = client(host)
			const alice = await host.login("agents-dana")
			const main = (
				await json(
					Schema.Array(AgentsApi.Agent),
					send(alice.session, "/v1/agents"),
				)
			)[0]!
			const created = await json(
				SessionView,
				send(alice.session, "/v1/sessions", "POST", {}),
			)
			const path = "/v1/sessions/" + created.session.id
			const view = () => json(SessionView, send(alice.session, path))
			const run = async (input: string) => {
				const current = await view()
				const started = await send(alice.session, path + "/turns", "POST", {
					expected: current.session.revision,
					input,
				})
				assert.equal(started.status, 202, await started.clone().text())
				return until("the Turn completes", async () => {
					const next = await view()
					return next.session.turns.length > current.session.turns.length &&
						Session.status(next.session)._tag === "Completed"
						? next
						: undefined
				})
			}
			const rule = await json(
				AgentsApi.Rule,
				send(alice.session, "/v1/agents/" + main.id + "/rules", "POST", {
					text: "Main may confirm changes with ConfirmChange.",
				}),
			)
			assert.equal(rule.status, "active")
			const before = host.toolCalls()
			await run("confirm directly")
			assert.equal(host.toolCalls(), before + 1)
			assert.deepEqual(
				await json(
					Schema.Array(RequestsApi.CapabilityRequest),
					send(alice.session, "/v1/requests"),
				),
				[],
			)
			const deny = await json(
				AgentsApi.Grant,
				send(alice.session, "/v1/agents/" + main.id + "/grants", "POST", {
					capability: { action: "tools.call", target: "ConfirmChange" },
					effect: "deny",
					scope: "lifetime",
					reason: "No more changes today.",
				}),
			)
			const denied = await run("confirm directly")
			assert.equal(host.toolCalls(), before + 1)
			assert.match(JSON.stringify(denied.state.value), /No more changes today/)
			const closed = await json(
				Schema.Array(RequestsApi.CapabilityRequest),
				send(alice.session, "/v1/requests?status=denied"),
			)
			assert.equal(closed.length, 1)
			assert.equal(
				(
					await send(
						alice.session,
						"/v1/agents/" + main.id + "/grants/" + deny.id,
						"DELETE",
					)
				).status,
				204,
			)
			await run("confirm directly")
			assert.equal(host.toolCalls(), before + 2)
		} finally {
			await host.close()
		}
	},
)
