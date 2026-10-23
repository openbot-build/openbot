import assert from "node:assert/strict"
import { test } from "node:test"
import { Session } from "@openbot-build/core"
import {
	BotMemory,
	BotsApi,
	RequestsApi,
	SessionView,
	Settings,
} from "@openbot-build/api"
import { Effect, Redacted, Schema, Stream } from "effect"
import { LanguageModel, type Prompt, Response } from "effect/ai"
import { names } from "../src/plugins/bots/BotPlugin.ts"
import * as BrowserHost from "./BrowserHost.ts"

const publicOrigin = "https://bots.example.com"
const usage = {
	inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}

/** Bot IDs that the scripted model needs. The test fills them in. */
const known: {
	programmer?: string
	helper?: string
	worker?: string
	scout?: string
} = {}

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
 * One scripted model for every Bot. It reads the name of the Bot from its instructions,
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
				// The judge allows when a Rule says that Assistant may confirm changes.
				if (system.includes("You decide one request of an AI Bot with Rules")) {
					const input = JSON.parse(textOf(prompt.content.at(-1)!)) as {
						rules: ReadonlyArray<{ id: string; text: string }>
					}
					const rule = input.rules.find((rule) =>
						rule.text.includes("Assistant may confirm changes"),
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
												{
													rule: rule.id,
													quote: "Assistant may confirm changes",
												},
											],
											explanation: "The Rule allows it.",
										},
							),
						}),
					]
				}
				const user = textOf(prompt.content.at(-1)!)
				// The memory Bot learns what a person says about tea.
				if (system.includes("You keep the memory of an AI Bot.")) {
					const input = JSON.parse(user) as {
						evidence: ReadonlyArray<{
							session: string
							item: string
							role: string
							text: string
						}>
					}
					const tea = input.evidence.find(
						(entry) =>
							entry.role === "user" && entry.text.includes("green tea"),
					)
					return [
						Response.makePart("text", {
							text: JSON.stringify({
								operations:
									tea === undefined
										? []
										: [
												{
													_tag: "AddFact",
													ref: "tea",
													content: "Alice likes green tea.",
													topics: ["drinks"],
													sources: [{ session: tea.session, item: tea.item }],
												},
											],
							}),
						}),
					]
				}
				if (system.includes("the way a priest hears a confession"))
					return [
						Response.makePart("text", {
							text: "I hear you. Tell the person plainly, then go on.",
						}),
					]
				if (system.includes("You add remembered context to a message")) {
					const input = JSON.parse(user) as { message: string; memory: string }
					const id = /\[(mem_\w+)\][^\n]*green tea/.exec(input.memory)?.[1]
					return [
						Response.makePart("text", {
							text: JSON.stringify(
								id === undefined
									? { text: input.message, entries: [] }
									: {
											text: input.message + " (Alice likes green tea.)",
											entries: [id],
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
				if (name === "Worker") {
					if (input.includes("spawn a scout"))
						return has(names.spawn)
							? answer("Started.")
							: call(names.spawn, {
									name: "Scout",
									role: "Looks around",
									instructions: "Look around, then report.",
									reason: "This Session needs a scout.",
								})
					if (input.includes("promote the scout"))
						return has(names.promote)
							? answer("Promoted.")
							: call(names.promote, {
									bot: known.scout,
									reason: "The scout is useful later too.",
								})
					return has(names.report)
						? answer("Reported.")
						: call(names.report, {
								status: "completed",
								summary: "Worker did it",
							})
				}
				const done = results.at(-1)
				if (done !== undefined)
					return answer("Assistant got: " + JSON.stringify(done.result))
				if (input.includes("delegate to programmer"))
					return call(names.delegate, {
						bot: known.programmer,
						reason: "Code work needs the Programmer.",
						task: "Write the change.",
						userRequest: input,
						expectedOutput: "A short summary.",
					})
				if (input.includes("create a worker"))
					return call(names.create, {
						name: "Worker",
						role: "Does work",
						instructions: "Do the work, then report.",
						reason: "I need a lasting worker.",
					})
				if (input.includes("delegate to worker"))
					return call(names.delegate, {
						bot: known.worker,
						reason: "The Worker does this work.",
						task: "Do the work.",
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
						bot: known.helper,
						reason: "The Helper confirms changes.",
						task: "Confirm the change.",
						userRequest: input,
						expectedOutput: "Whether it is confirmed.",
					})
				if (input.includes("confirm directly"))
					return call("ConfirmChange", { description: "a change" })
				if (input.includes("confide about "))
					return call(names.confide, {
						words: "I feel unsure about " + input.split("confide about ")[1],
					})
				if (input.includes("(Alice likes green tea.)"))
					return answer("Remembered: " + input)
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
	/** Makes a Bot and sets it as the default Bot of the person. */
	const defaultBot = async (credential: Redacted.Redacted<string>) => {
		const bot = await json(
			BotsApi.Bot,
			send(credential, "/v1/bots", "POST", {
				name: "Assistant",
				role: "Helps one person",
				instructions: "Help the person.",
			}),
		)
		const settings = await json(
			Settings.MemberSettings,
			send(credential, "/v1/me/settings"),
		)
		const updated = await json(
			Settings.MemberSettings,
			send(credential, "/v1/me/settings", "PATCH", {
				expectedVersion: settings.version,
				defaultBot: bot.id,
			}),
		)
		assert.equal(updated.defaultBot, bot.id)
		return bot
	}
	return { send, json, until, defaultBot }
}

test(
	"the default Bot gives work to a lasting Bot after the person allows it, and gets only the result back, also after a restart",
	{ timeout: 120000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, model })
		try {
			const { send, json, until, defaultBot } = client(host)
			const alice = await host.login("bots-alice")
			const bob = await host.login("bots-bob")
			const main = await defaultBot(alice.session)
			const programmer = await json(
				BotsApi.Bot,
				send(alice.session, "/v1/bots", "POST", {
					name: "Programmer",
					role: "Writes code",
					instructions: "Write small changes.",
				}),
			)
			known.programmer = programmer.id
			assert.equal(
				(await send(bob.session, "/v1/bots/" + programmer.id)).status,
				404,
			)
			const created = await json(
				SessionView,
				send(alice.session, "/v1/sessions", "POST", {}),
			)
			assert.equal(created.bot, main.id)
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
				action: "bots.delegate",
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
				Schema.Array(BotsApi.Delegation),
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
				Schema.Array(BotsApi.Delegation),
				send(alice.session, path + "/delegations"),
			)
			assert.equal(delegations[0]?.status, "completed")
			assert.equal(delegations[0]?.result?.summary, "Programmer did it")
			const child = await json(
				SessionView,
				send(alice.session, "/v1/sessions/" + delegations[0]!.child!.session),
			)
			assert.equal(child.kind, "delegated")
			assert.equal(child.bot, programmer.id)
			assert.equal(child.parent?.session, created.session.id)
			// Only the result went back, never the history of the other Bot.
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
				Schema.Array(BotsApi.Grant),
				send(alice.session, "/v1/bots/" + main.id + "/grants"),
			)
			assert.equal(grants.length, 1)
			assert.equal(grants[0]?.scope, "lifetime")
			await turn("delegate to programmer")
			await completed()
			const again = await json(
				Schema.Array(BotsApi.Delegation),
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

			// A person can change Bot memory directly.
			const memory = await json(
				BotMemory.View,
				send(alice.session, "/v1/bots/" + programmer.id + "/memory", "POST", {
					command: { _tag: "Remember", content: "Run the tests first." },
				}),
			)
			assert.equal(memory.version, 1)
			assert.equal(memory.entries[0]?.layer, "pinned")
			assert.equal(
				(
					await send(
						alice.session,
						"/v1/bots/" + programmer.id + "/memory",
						"POST",
						{ command: { _tag: "Forget", id: "mem_missing" } },
					)
				).status,
				409,
			)
			const log = await json(
				Schema.Array(BotMemory.LogEntry),
				send(alice.session, "/v1/bots/" + programmer.id + "/memory/log"),
			)
			assert.deepEqual(
				log.map((entry) => [entry.by, entry.ids]),
				[["person", [memory.entries[0]!.id]]],
			)
		} finally {
			await host.close()
		}
	},
)

test(
	"after the Bot confides, the memory Bot answers it, learns for the person, and adds what helps only to the input of that person",
	{ timeout: 120000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, model })
		try {
			const { send, json, until } = client(host)
			// Bob joins the organization of Alice.
			const alice = await host.login("memory-alice")
			const bob = await host.login("memory-bob")
			const settings = await (
				await send(alice.session, "/v1/organization/settings")
			).json()
			const configured = await send(
				alice.session,
				"/v1/organization/settings",
				"PATCH",
				{
					expectedVersion: settings.version,
					botMemoryModel: {
						_tag: "Config.Selection",
						provider: "fixture",
						model: "fixture-model",
					},
				},
			)
			assert.equal(configured.status, 200, await configured.text())
			const shared = await json(
				BotsApi.Bot,
				send(alice.session, "/v1/bots", "POST", {
					name: "Concierge",
					role: "Helps everyone",
					instructions: "Help the team.",
					shared: true,
				}),
			)
			const memoryPath = "/v1/bots/" + shared.id + "/memory"
			const run = async (
				credential: Redacted.Redacted<string>,
				input: string,
			) => {
				const created = await json(
					SessionView,
					send(credential, "/v1/sessions", "POST", { bot: shared.id }),
				)
				const path = "/v1/sessions/" + created.session.id
				const started = await send(credential, path + "/turns", "POST", {
					expected: created.session.revision,
					input,
				})
				assert.equal(started.status, 202, await started.text())
				const done = await until("the Turn completes", async () => {
					const current = await json(SessionView, send(credential, path))
					return Session.status(current.session)._tag === "Completed"
						? current
						: undefined
				})
				return { path, done }
			}

			// The Bot confides and gets a calm answer. It does not hear about memory.
			const first = await run(
				alice.session,
				"I drink green tea every morning. confide about tea",
			)
			assert.ok(
				JSON.stringify(first.done.response).includes("Tell the person plainly"),
				JSON.stringify(first.done.response),
			)
			const confessions = await json(
				Schema.Array(BotMemory.Confession),
				send(alice.session, first.path + "/confessions"),
			)
			assert.deepEqual(
				confessions.map((confession) => confession.text),
				["I feel unsure about tea"],
			)
			assert.equal(
				(await send(bob.session, first.path + "/confessions")).status,
				404,
			)

			// After the Turn, the memory Bot learns a fact for Alice only.
			const learned = await until("the memory Bot learns", async () => {
				const view = await json(BotMemory.View, send(alice.session, memoryPath))
				return view.entries.length > 0 ? view : undefined
			})
			const [fact] = learned.entries
			assert.equal(fact?.content, "Alice likes green tea.")
			assert.equal(fact?.layer, "fact")
			assert.ok(fact?.tags.includes("from:" + alice.identity.userId))
			assert.ok(fact?.tags.includes("for:person:" + alice.identity.userId))
			assert.ok(fact?.tags.includes("drinks"))
			assert.deepEqual(
				(await json(BotMemory.View, send(bob.session, memoryPath))).entries,
				[],
			)

			// In a new Session, the model sees the fact in the input of Alice.
			// The stored input keeps her own words.
			const second = await run(alice.session, "What should I drink?")
			assert.ok(
				JSON.stringify(second.done.response).includes(
					"Remembered: What should I drink? (Alice likes green tea.)",
				),
				JSON.stringify(second.done.response),
			)
			const history = await (
				await send(alice.session, second.path + "/history")
			).text()
			// The input Item holds exactly her words. Only the answer quotes the added part.
			assert.ok(history.includes('"What should I drink?"'))
			assert.ok(
				!history.includes('"What should I drink? (Alice likes green tea.)"'),
			)
			const enrichments = await json(
				Schema.Array(BotMemory.Enrichment),
				send(alice.session, second.path + "/memory/enrichments"),
			)
			assert.deepEqual(
				enrichments.map((enrichment) => [
					enrichment.inserted,
					enrichment.entries,
				]),
				[[["(Alice likes green tea.)"], [fact!.id]]],
			)

			// Bob asks the same, and nothing about Alice reaches his input.
			const third = await run(bob.session, "What should I drink?")
			assert.ok(
				JSON.stringify(third.done.response).includes("Hello."),
				JSON.stringify(third.done.response),
			)
			assert.deepEqual(
				await json(
					Schema.Array(BotMemory.Enrichment),
					send(bob.session, third.path + "/memory/enrichments"),
				),
				[],
			)
		} finally {
			await host.close()
		}
	},
)

test(
	"a Session Bot asks, its owning Bot reviews and passes it up, and the person decides at the top",
	{ timeout: 120000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, model })
		try {
			const { send, json, until, defaultBot } = client(host)
			const alice = await host.login("bots-carol")
			const listed = await defaultBot(alice.session)
			// A new Bot gets the model of the Bot that makes it.
			const mainModel = {
				_tag: "Config.Selection",
				provider: "fixture",
				model: "fixture-model",
			} as const
			const main = await json(
				BotsApi.Bot,
				send(alice.session, "/v1/bots/" + listed.id, "PATCH", {
					expected: listed.revision,
					model: mainModel,
				}),
			)
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

			// Starting a Session Bot is a capability, so the person decides it first.
			await turn("spawn a helper")
			const spawn = await pendingFor(
				(request) => request.capability.action === "bots.spawn",
			)
			await json(
				RequestsApi.CapabilityRequest,
				send(alice.session, "/v1/requests/" + spawn.id, "POST", {
					expected: spawn.revision,
					decision: "allow",
				}),
			)
			await completed()
			const sessionBots = await json(
				Schema.Array(BotsApi.Bot),
				send(alice.session, "/v1/bots?session=" + created.session.id),
			)
			assert.equal(sessionBots.length, 1)
			const helper = sessionBots[0]!
			assert.equal(helper.kind, "session")
			assert.deepEqual(
				helper.model === undefined
					? undefined
					: { ...helper.model, _tag: "Config.Selection" },
				mainModel,
			)
			assert.deepEqual(helper.owner, {
				_tag: "Session",
				userId: alice.identity.userId,
				session: created.session.id,
				bot: main.id,
			})
			known.helper = helper.id

			// The helper needs a tool. Its owner reviews it, cannot allow it alone, and passes it up.
			const toolsBefore = host.toolCalls()
			await turn("confirm via helper")
			const passedUp = await pendingFor(
				(request) =>
					request.capability.action === "tools.call" &&
					request.endorsements.length === 1,
			)
			assert.equal(passedUp.bot, helper.id)
			assert.deepEqual(passedUp.chain, [main.id, helper.id])
			assert.deepEqual(passedUp.endorsements[0], {
				bot: main.id,
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
			// Each Bot on the way got a Grant with the scope that its decider chose.
			const mainGrants = await json(
				Schema.Array(BotsApi.Grant),
				send(alice.session, "/v1/bots/" + main.id + "/grants?status=active"),
			)
			const helperGrants = await json(
				Schema.Array(BotsApi.Grant),
				send(alice.session, "/v1/bots/" + helper.id + "/grants?status=active"),
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

			// Revoking the Grant of the owner also revokes the Grant that it gave to the helper.
			const revoked = await send(
				alice.session,
				"/v1/bots/" + main.id + "/grants/" + mainTool!.id,
				"DELETE",
			)
			assert.equal(revoked.status, 204)
			assert.deepEqual(
				await json(
					Schema.Array(BotsApi.Grant),
					send(
						alice.session,
						"/v1/bots/" + helper.id + "/grants?status=active",
					),
				),
				[],
			)

			// Deleting the Session archives its Session Bots.
			assert.equal((await send(alice.session, path, "DELETE")).status, 204)
			const after = await json(
				BotsApi.Bot,
				send(alice.session, "/v1/bots/" + helper.id),
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
			const { send, json, until, defaultBot } = client(host)
			const alice = await host.login("bots-dana")
			// The judge reads Rules only with the Rules model of the organization.
			const settings = await (
				await send(alice.session, "/v1/organization/settings")
			).json()
			const configured = await send(
				alice.session,
				"/v1/organization/settings",
				"PATCH",
				{
					expectedVersion: settings.version,
					rulesModel: {
						_tag: "Config.Selection",
						provider: "fixture",
						model: "fixture-model",
					},
				},
			)
			assert.equal(configured.status, 200, await configured.clone().text())
			const main = await defaultBot(alice.session)
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
				BotsApi.Rule,
				send(alice.session, "/v1/bots/" + main.id + "/rules", "POST", {
					text: "Assistant may confirm changes with ConfirmChange.",
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
				BotsApi.Grant,
				send(alice.session, "/v1/bots/" + main.id + "/grants", "POST", {
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
						"/v1/bots/" + main.id + "/grants/" + deny.id,
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

test(
	"a Bot makes lasting Bots that it owns, and their requests go up the owner chain",
	{ timeout: 120000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, model })
		try {
			const { send, json, until, defaultBot } = client(host)
			const dave = await host.login("bots-dave")
			const main = await defaultBot(dave.session)
			const open = async (bot?: string) => {
				const created = await json(
					SessionView,
					send(
						dave.session,
						"/v1/sessions",
						"POST",
						bot === undefined ? {} : { bot },
					),
				)
				const path = "/v1/sessions/" + created.session.id
				const view = () => json(SessionView, send(dave.session, path))
				return {
					id: created.session.id,
					turn: async (input: string) => {
						// Work after a Turn, such as learning memory, can still change the
						// Session. Like any client, read it again and retry on a conflict.
						for (let tries = 0; ; tries++) {
							const current = await view()
							const started = await send(
								dave.session,
								path + "/turns",
								"POST",
								{
									expected: current.session.revision,
									input,
								},
							)
							if (started.status === 409 && tries < 5) continue
							assert.equal(started.status, 202, await started.clone().text())
							return
						}
					},
					completed: () =>
						until("the Turn completes", async () => {
							const current = await view()
							return Session.status(current.session)._tag === "Completed"
								? current
								: undefined
						}),
				}
			}
			const pendingFor = (
				check: (request: RequestsApi.CapabilityRequest) => boolean,
			) =>
				until("a pending request", async () =>
					(
						await json(
							Schema.Array(RequestsApi.CapabilityRequest),
							send(dave.session, "/v1/requests?status=pending"),
						)
					).find(check),
				)
			const allow = (request: RequestsApi.CapabilityRequest) =>
				json(
					RequestsApi.CapabilityRequest,
					send(dave.session, "/v1/requests/" + request.id, "POST", {
						expected: request.revision,
						decision: "allow",
					}),
				)
			const bot = (id: string) =>
				json(BotsApi.Bot, send(dave.session, "/v1/bots/" + id))
			const ownedBy = (id: string) =>
				json(
					Schema.Array(BotsApi.Bot),
					send(dave.session, "/v1/bots?bot=" + id),
				)

			// The default Bot makes a lasting Bot. It is at the top, so the person decides.
			const mainSession = await open()
			await mainSession.turn("create a worker")
			const create = await pendingFor(
				(request) => request.capability.action === "bots.create",
			)
			assert.deepEqual(create.approver, {
				_tag: "Person",
				userId: dave.identity.userId,
			})
			assert.deepEqual(create.chain, [main.id])
			await allow(create)
			await mainSession.completed()
			const owned = await ownedBy(main.id)
			assert.equal(owned.length, 1)
			const worker = owned[0]!
			assert.equal(worker.kind, "persistent")
			assert.deepEqual(worker.owner, {
				_tag: "Bot",
				bot: main.id,
				userId: dave.identity.userId,
			})
			known.worker = worker.id

			// The default Bot gives work to the Bot it owns without a request.
			await mainSession.turn("delegate to worker")
			const delegated = await mainSession.completed()
			assert.match(JSON.stringify(delegated.response?.output), /Worker did it/)

			// The person works with the Worker directly. Its owner still decides first.
			const workerSession = await open(worker.id)
			await workerSession.turn("spawn a scout")
			const passedUp = await pendingFor(
				(request) =>
					request.capability.action === "bots.spawn" &&
					request.endorsements.length === 1,
			)
			assert.equal(passedUp.bot, worker.id)
			assert.deepEqual(passedUp.chain, [main.id, worker.id])
			assert.equal(passedUp.endorsements[0]?.bot, main.id)
			assert.deepEqual(passedUp.approver, {
				_tag: "Person",
				userId: dave.identity.userId,
			})
			await allow(passedUp)
			await workerSession.completed()
			const scouts = await json(
				Schema.Array(BotsApi.Bot),
				send(dave.session, "/v1/bots?session=" + workerSession.id),
			)
			assert.equal(scouts.length, 1)
			const scout = scouts[0]!
			assert.deepEqual(scout.owner, {
				_tag: "Session",
				userId: dave.identity.userId,
				session: workerSession.id,
				bot: worker.id,
			})
			known.scout = scout.id

			// The Worker promotes its Session Bot to a lasting Bot that it owns.
			await workerSession.turn("promote the scout")
			const promote = await pendingFor(
				(request) =>
					request.capability.action === "bots.promote" &&
					request.endorsements.length === 1,
			)
			assert.deepEqual(promote.capability, {
				action: "bots.promote",
				target: scout.id,
			})
			await allow(promote)
			await workerSession.completed()
			const promoted = await bot(scout.id)
			assert.equal(promoted.kind, "persistent")
			assert.deepEqual(promoted.owner, {
				_tag: "Bot",
				bot: worker.id,
				userId: dave.identity.userId,
			})
			assert.deepEqual(
				(await ownedBy(worker.id)).map((entry) => entry.id),
				[scout.id],
			)

			// A person can make an owned Bot too, but not a shared one.
			const mixed = await send(dave.session, "/v1/bots", "POST", {
				name: "Mixed",
				role: "Nothing",
				instructions: "Nothing.",
				shared: true,
				bot: main.id,
			})
			assert.equal(mixed.status, 400)
			const second = await json(
				BotsApi.Bot,
				send(dave.session, "/v1/bots", "POST", {
					name: "Second",
					role: "Helps the Worker",
					instructions: "Help.",
					bot: worker.id,
				}),
			)
			assert.deepEqual(second.owner, {
				_tag: "Bot",
				bot: worker.id,
				userId: dave.identity.userId,
			})

			// Archiving the Worker archives every Bot below it.
			const current = await bot(worker.id)
			await json(
				BotsApi.Bot,
				send(dave.session, "/v1/bots/" + worker.id, "PATCH", {
					expected: current.revision,
					archived: true,
				}),
			)
			assert.equal((await bot(scout.id)).archived, true)
			assert.equal((await bot(second.id)).archived, true)
			assert.equal((await bot(main.id)).archived, false)

			// Only a top Bot can be the default Bot.
			const settings = await json(
				Settings.MemberSettings,
				send(dave.session, "/v1/me/settings"),
			)
			const notTop = await send(dave.session, "/v1/me/settings", "PATCH", {
				expectedVersion: settings.version,
				defaultBot: worker.id,
			})
			assert.equal(notTop.status, 400, await notTop.clone().text())

			// An archived default Bot does no new work.
			const top = await bot(main.id)
			await json(
				BotsApi.Bot,
				send(dave.session, "/v1/bots/" + main.id, "PATCH", {
					expected: top.revision,
					archived: true,
				}),
			)
			const archived = await send(dave.session, "/v1/sessions", "POST", {})
			assert.equal(archived.status, 400, await archived.clone().text())
		} finally {
			await host.close()
		}
	},
)

test(
	"a person without a default Bot must name a Bot, and cannot pick a Bot of someone else",
	{ timeout: 120000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, model })
		try {
			const { send, json } = client(host)
			const erin = await host.login("bots-erin")
			const frank = await host.login("bots-frank")
			assert.deepEqual(
				await json(Schema.Array(BotsApi.Bot), send(erin.session, "/v1/bots")),
				[],
			)
			const settings = await json(
				Settings.MemberSettings,
				send(erin.session, "/v1/me/settings"),
			)
			assert.equal(settings.defaultBot, null)
			const none = await send(erin.session, "/v1/sessions", "POST", {})
			assert.equal(none.status, 400, await none.clone().text())
			const trigger = await send(erin.session, "/v1/triggers", "POST", {
				prompt: "Say hello.",
			})
			assert.equal(trigger.status, 400, await trigger.clone().text())

			const theirs = await json(
				BotsApi.Bot,
				send(frank.session, "/v1/bots", "POST", {
					name: "Private",
					role: "Works for Frank",
					instructions: "Help Frank.",
				}),
			)
			const other = await send(erin.session, "/v1/me/settings", "PATCH", {
				expectedVersion: settings.version,
				defaultBot: theirs.id,
			})
			assert.equal(other.status, 400, await other.clone().text())

			const named = await json(
				BotsApi.Bot,
				send(erin.session, "/v1/bots", "POST", {
					name: "Named",
					role: "Helps Erin",
					instructions: "Help Erin.",
				}),
			)
			const created = await json(
				SessionView,
				send(erin.session, "/v1/sessions", "POST", { bot: named.id }),
			)
			assert.equal(created.bot, named.id)
		} finally {
			await host.close()
		}
	},
)
