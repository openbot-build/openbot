import assert from "node:assert/strict"
import { test } from "node:test"
import { Item } from "@openbot-build/core"
import {
	BotMemory,
	BotsApi,
	ChatInfo,
	ChatView,
	DelegationsApi,
	MessageReceipt,
	RequestsApi,
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
							chat: string
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
													sources: [{ chat: tea.chat, item: tea.item }],
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
				// The Programmer reads something first, so its history holds more than the result.
				if (name === "Programmer")
					return has(names.list)
						? answer("Programmer did it")
						: call(names.list, {})
				if (name === "Helper") {
					if (!has("ConfirmChange"))
						return call("ConfirmChange", { description: "helper change" })
					return answer(
						JSON.stringify(results.at(-1)?.result).includes("pending")
							? "Helper waits for a decision."
							: "Helper confirmed it",
					)
				}
				if (name === "Worker") {
					if (input.includes("create a scout"))
						return has(names.create)
							? answer("Asked for a scout.")
							: call(names.create, {
									name: "Scout",
									role: "Looks around",
									instructions: "Look around.",
									reason: "I need a scout.",
								})
					return answer("Worker did it")
				}
				// A message from OpenBot about work that ended.
				if (input.includes("[OpenBot] The work dlg_"))
					return answer("Assistant read: " + input)
				const done = results.at(-1)
				if (done !== undefined)
					return answer("Assistant got: " + JSON.stringify(done.result))
				if (input.includes("delegate to programmer"))
					return call(names.delegate, {
						bot: known.programmer,
						reason: "Code work needs the Programmer.",
						task: "Write the change.",
					})
				if (input.includes("create a worker"))
					return call(names.create, {
						name: "Worker",
						role: "Does work",
						instructions: "Do the work.",
						reason: "I need a lasting worker.",
					})
				if (input.includes("delegate to worker"))
					return call(names.delegate, {
						bot: known.worker,
						task: "Do the work.",
					})
				if (input.includes("confirm via helper"))
					return call(names.delegate, {
						bot: known.helper,
						reason: "The Helper confirms changes.",
						task: "Confirm the change.",
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
	/**
	 * The direct Chat of a person with a Bot. `message` sends and answers at once;
	 * `rested` waits until no Turn runs and nothing waits in the inbox.
	 */
	const talk = (credential: Redacted.Redacted<string>, bot: string) => {
		let chat = ""
		const view = () => json(ChatView, send(credential, "/v1/chats/" + chat))
		const message = async (input: string) => {
			const sent = await send(
				credential,
				"/v1/bots/" + bot + "/messages",
				"POST",
				{
					input,
				},
			)
			assert.equal(sent.status, 202, await sent.clone().text())
			const receipt = Schema.decodeUnknownSync(MessageReceipt)(
				await sent.json(),
			)
			chat = receipt.chat
			return receipt
		}
		const rested = () =>
			until("the Chat comes to rest", async () => {
				const current = await view()
				return current.status !== "Running" &&
					current.activity !== "active" &&
					current.inbox === 0
					? current
					: undefined
			})
		/** The text of every Item, oldest first. */
		const history = async (id = chat) =>
			(
				await json(
					Schema.Struct({ items: Schema.Array(Item.Record) }),
					send(credential, "/v1/chats/" + id + "/items?limit=500"),
				)
			).items
				.toReversed()
				.map((item) => JSON.stringify(item.content))
				.join("\n")
		const delegations = () =>
			json(
				Schema.Array(DelegationsApi.Delegation),
				send(credential, "/v1/chats/" + chat + "/delegations"),
			)
		return {
			chat: () => chat,
			view,
			message,
			rested,
			history,
			delegations,
			/** Sends a message and waits until the Chat comes to rest. */
			turn: async (input: string) => {
				await message(input)
				return rested()
			},
			/** Waits until the history says something. */
			says: (text: string, id?: string) =>
				until("the history says " + text, async () =>
					(await history(id)).includes(text) ? true : undefined,
				),
		}
	}
	const pendingFor = (
		credential: Redacted.Redacted<string>,
		check: (request: RequestsApi.CapabilityRequest) => boolean,
	) =>
		until("a pending request", async () =>
			(
				await json(
					Schema.Array(RequestsApi.CapabilityRequest),
					send(credential, "/v1/requests?status=pending"),
				)
			).find(check),
		)
	return { send, json, until, defaultBot, talk, pendingFor }
}

test(
	"the default Bot gives work to another Bot after the person allows it, does not wait, and gets only the result back as a message, also after a restart",
	{ timeout: 120000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, model })
		try {
			const { send, json, until, defaultBot, talk, pendingFor } = client(host)
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
			const chat = talk(alice.session, main.id)

			// The Bot gives the work away and answers at once. The work waits for a decision.
			const asked = await chat.turn("delegate to programmer")
			assert.equal(asked.chat.kind, "direct")
			assert.equal(asked.chat.bot, main.id)
			assert.equal(asked.status, "Completed")
			assert.equal(asked.open.delegations, 1)
			assert.match(await chat.history(), /authorizing/)
			const request = await pendingFor(alice.session, () => true)
			assert.deepEqual(request.capability, {
				action: "bots.delegate",
				target: programmer.id,
			})
			assert.deepEqual(request.approver, {
				_tag: "Person",
				userId: alice.identity.userId,
			})
			assert.equal(request.chat, chat.chat())
			const waiting = await chat.delegations()
			assert.equal(waiting[0]?.status, "authorizing")
			assert.equal(waiting[0]?.chat, null)

			// The work is saved, so a restart does not lose it.
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
			const finished = await until("the work ends", async () => {
				const list = await chat.delegations()
				return list[0]?.status === "completed" ? list[0] : undefined
			})
			assert.equal(finished.result, "Programmer did it")
			assert.equal(finished.parent.chat, chat.chat())
			// The result comes back as a message, and the Bot answers it in a new Turn.
			await chat.says("Assistant read: [OpenBot] The work " + finished.id)
			const done = await chat.rested()
			assert.equal(done.open.delegations, 0)
			assert.match(JSON.stringify(done.response?.output), /Programmer did it/)

			// The work ran in its own task Chat.
			assert.ok(finished.chat !== null)
			const task = await json(
				ChatView,
				send(alice.session, "/v1/chats/" + finished.chat),
			)
			assert.equal(task.chat.kind, "task")
			assert.equal(task.chat.bot, programmer.id)
			assert.deepEqual(task.chat.parent, {
				chat: chat.chat(),
				delegation: finished.id,
			})
			// Only the result went back, never the history of the other Bot.
			const parentHistory = await chat.history()
			assert.ok(parentHistory.includes("Write the change."))
			assert.ok(parentHistory.includes("Programmer did it"))
			assert.ok(!parentHistory.includes(names.list))
			assert.ok((await chat.history(finished.chat)).includes(names.list))
			// Task Chats are not in the list of Chats of a person.
			const listed = await json(
				Schema.Array(Schema.Struct({ chat: ChatInfo })),
				send(alice.session, "/v1/chats"),
			)
			assert.deepEqual(
				listed.map((entry) => entry.chat.id),
				[chat.chat()],
			)

			// The decision is kept as a Grant, so the second time needs no request.
			const grants = await json(
				Schema.Array(BotsApi.Grant),
				send(alice.session, "/v1/bots/" + main.id + "/grants"),
			)
			assert.equal(grants.length, 1)
			assert.equal(grants[0]?.scope, "lifetime")
			await chat.turn("delegate to programmer")
			await until("the second work ends", async () => {
				const list = await chat.delegations()
				return list.filter((entry) => entry.status === "completed").length === 2
					? list
					: undefined
			})
			assert.deepEqual(
				await json(
					Schema.Array(RequestsApi.CapabilityRequest),
					send(alice.session, "/v1/requests?status=pending"),
				),
				[],
			)
			await chat.rested()

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
			const { send, json, until, talk } = client(host)
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
			const aliceChat = talk(alice.session, shared.id)
			const bobChat = talk(bob.session, shared.id)

			// The Bot confides and gets a calm answer. It does not hear about memory.
			const first = await aliceChat.turn(
				"I drink green tea every morning. confide about tea",
			)
			assert.ok(
				JSON.stringify(first.response).includes("Tell the person plainly"),
				JSON.stringify(first.response),
			)
			const path = "/v1/chats/" + aliceChat.chat()
			const confessions = await json(
				Schema.Array(BotMemory.Confession),
				send(alice.session, path + "/confessions"),
			)
			assert.deepEqual(
				confessions.map((confession) => confession.text),
				["I feel unsure about tea"],
			)
			assert.equal((await send(bob.session, path + "/confessions")).status, 404)

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
			const [source] = fact?.sources ?? []
			assert.ok(source !== undefined && "chat" in source)
			assert.equal(source.chat, aliceChat.chat())
			assert.deepEqual(
				(await json(BotMemory.View, send(bob.session, memoryPath))).entries,
				[],
			)

			// Later, the model sees the fact in the input of Alice.
			// The stored input keeps her own words.
			const second = await aliceChat.turn("What should I drink?")
			assert.ok(
				JSON.stringify(second.response).includes(
					"Remembered: What should I drink? (Alice likes green tea.)",
				),
				JSON.stringify(second.response),
			)
			const history = await aliceChat.history()
			// The input Item holds exactly her words. Only the answer quotes the added part.
			assert.ok(history.includes('"What should I drink?"'))
			assert.ok(
				!history.includes('"What should I drink? (Alice likes green tea.)"'),
			)
			const enrichments = await json(
				Schema.Array(BotMemory.Enrichment),
				send(alice.session, path + "/enrichments"),
			)
			assert.deepEqual(
				enrichments.map((enrichment) => [
					enrichment.inserted,
					enrichment.entries,
				]),
				[[["(Alice likes green tea.)"], [fact!.id]]],
			)

			// Bob asks the same in his own Chat, and nothing about Alice reaches his input.
			const third = await bobChat.turn("What should I drink?")
			assert.notEqual(bobChat.chat(), aliceChat.chat())
			assert.ok(
				JSON.stringify(third.response).includes("Hello."),
				JSON.stringify(third.response),
			)
			assert.deepEqual(
				await json(
					Schema.Array(BotMemory.Enrichment),
					send(bob.session, "/v1/chats/" + bobChat.chat() + "/enrichments"),
				),
				[],
			)
		} finally {
			await host.close()
		}
	},
)

test(
	"a Bot that another Bot owns asks, its owner reviews and passes it up, and the person decides at the top",
	{ timeout: 120000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, model })
		try {
			const { send, json, until, defaultBot, talk, pendingFor } = client(host)
			const alice = await host.login("bots-carol")
			const main = await defaultBot(alice.session)
			const helper = await json(
				BotsApi.Bot,
				send(alice.session, "/v1/bots", "POST", {
					name: "Helper",
					role: "Confirms changes",
					instructions: "Confirm the change.",
					bot: main.id,
				}),
			)
			assert.deepEqual(helper.owner, {
				_tag: "Bot",
				bot: main.id,
				userId: alice.identity.userId,
			})
			known.helper = helper.id
			const chat = talk(alice.session, main.id)

			// The default Bot gives work to the Bot it owns without a request.
			// The Helper needs a tool. Its owner reviews it, cannot allow it alone, and passes it up.
			const toolsBefore = host.toolCalls()
			await chat.turn("confirm via helper")
			const passedUp = await pendingFor(
				alice.session,
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
			// The Helper does not wait. Its work stays open while the request is open.
			const [work] = await chat.delegations()
			assert.equal(work?.status, "running")
			assert.equal(passedUp.chat, work?.chat)
			await chat.says("Helper waits for a decision.", work!.chat!)

			await json(
				RequestsApi.CapabilityRequest,
				send(alice.session, "/v1/requests/" + passedUp.id, "POST", {
					expected: passedUp.revision,
					decision: "allow",
					scope: "chat",
				}),
			)
			// The allowed call runs in the task Chat, the work ends, and its result comes back.
			await chat.says("Helper confirmed it")
			assert.equal(host.toolCalls(), toolsBefore + 1)
			const [ended] = await chat.delegations()
			assert.equal(ended?.status, "completed")
			assert.equal(ended?.result, "Helper confirmed it")
			await chat.rested()

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
			// A Grant for one Chat holds where that Bot works: the default Bot in its direct Chat.
			assert.equal(mainTool?.scope, "chat")
			assert.equal(mainTool?.chat, chat.chat())
			assert.equal(helperGrants[0]?.scope, "lifetime")
			assert.equal(helperGrants[0]?.parent, mainTool?.id)

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

			// Deleting the direct Chat removes its history. The next message starts again.
			assert.equal(
				(await send(alice.session, "/v1/chats/" + chat.chat(), "DELETE"))
					.status,
				204,
			)
			assert.equal(
				(await send(alice.session, "/v1/chats/" + chat.chat())).status,
				404,
			)
			const old = chat.chat()
			await chat.turn("hello")
			assert.notEqual(chat.chat(), old)
			assert.ok(!(await chat.history()).includes("confirm via helper"))
			await until("the helper is still there", async () =>
				(await json(BotsApi.Bot, send(alice.session, "/v1/bots/" + helper.id)))
					.archived
					? undefined
					: true,
			)
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
			const { send, json, defaultBot, talk } = client(host)
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
			const chat = talk(alice.session, main.id)
			const rule = await json(
				BotsApi.Rule,
				send(alice.session, "/v1/bots/" + main.id + "/rules", "POST", {
					text: "Assistant may confirm changes with ConfirmChange.",
				}),
			)
			assert.equal(rule.status, "active")
			const before = host.toolCalls()
			await chat.turn("confirm directly")
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
			// The deny is decided at once, in the same Turn. The Bot reads the reason.
			const denied = await chat.turn("confirm directly")
			assert.equal(host.toolCalls(), before + 1)
			assert.equal(denied.status, "Completed")
			assert.equal(denied.open.requests, 0)
			assert.match(await chat.history(), /No more changes today/)
			assert.deepEqual(
				await json(
					Schema.Array(RequestsApi.CapabilityRequest),
					send(alice.session, "/v1/requests?status=pending"),
				),
				[],
			)
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
			await chat.turn("confirm directly")
			assert.equal(host.toolCalls(), before + 2)
		} finally {
			await host.close()
		}
	},
)

test(
	"a Bot makes Bots that it owns, and their requests go up the owner chain",
	{ timeout: 120000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, model })
		try {
			const { send, json, until, defaultBot, talk, pendingFor } = client(host)
			const dave = await host.login("bots-dave")
			const main = await defaultBot(dave.session)
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

			// The default Bot makes a Bot. It is at the top, so the person decides.
			// The Bot does not wait for the decision. When it comes, the call runs.
			const mainChat = talk(dave.session, main.id)
			const asked = await mainChat.turn("create a worker")
			assert.equal(asked.open.requests, 1)
			const create = await pendingFor(
				dave.session,
				(request) => request.capability.action === "bots.create",
			)
			assert.deepEqual(create.approver, {
				_tag: "Person",
				userId: dave.identity.userId,
			})
			assert.deepEqual(create.chain, [main.id])
			await allow(create)
			const owned = await until("the worker exists", async () => {
				const list = await ownedBy(main.id)
				return list.length === 1 ? list : undefined
			})
			const worker = owned[0]!
			assert.deepEqual(worker.owner, {
				_tag: "Bot",
				bot: main.id,
				userId: dave.identity.userId,
			})
			known.worker = worker.id
			await mainChat.rested()

			// The default Bot gives work to the Bot it owns without a request.
			await mainChat.turn("delegate to worker")
			await mainChat.says("Worker did it")
			await mainChat.rested()

			// The person works with the Worker directly. Its owner still decides first.
			const workerChat = talk(dave.session, worker.id)
			await workerChat.turn("create a scout")
			const passedUp = await pendingFor(
				dave.session,
				(request) =>
					request.capability.action === "bots.create" &&
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
			const scouts = await until("the scout exists", async () => {
				const list = await ownedBy(worker.id)
				return list.length === 1 ? list : undefined
			})
			const scout = scouts[0]!
			assert.deepEqual(scout.owner, {
				_tag: "Bot",
				bot: worker.id,
				userId: dave.identity.userId,
			})
			await workerChat.rested()

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

			// An archived Bot does no new work.
			const top = await bot(main.id)
			await json(
				BotsApi.Bot,
				send(dave.session, "/v1/bots/" + main.id, "PATCH", {
					expected: top.revision,
					archived: true,
				}),
			)
			const archived = await send(
				dave.session,
				"/v1/bots/" + main.id + "/messages",
				"POST",
				{ input: "hello" },
			)
			assert.equal(archived.status, 400, await archived.clone().text())
		} finally {
			await host.close()
		}
	},
)

test(
	"a person talks only to Bots that they may use, and a trigger needs a Bot",
	{ timeout: 120000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, model })
		try {
			const { send, json, talk } = client(host)
			// Frank comes first and runs the organization. Erin is a member.
			const frank = await host.login("bots-frank")
			const erin = await host.login("bots-erin")
			assert.deepEqual(
				await json(Schema.Array(BotsApi.Bot), send(erin.session, "/v1/bots")),
				[],
			)
			const settings = await json(
				Settings.MemberSettings,
				send(erin.session, "/v1/me/settings"),
			)
			assert.equal(settings.defaultBot, null)
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
			const hidden = await send(
				erin.session,
				"/v1/bots/" + theirs.id + "/messages",
				"POST",
				{ input: "hello" },
			)
			assert.equal(hidden.status, 404, await hidden.clone().text())

			const named = await json(
				BotsApi.Bot,
				send(erin.session, "/v1/bots", "POST", {
					name: "Named",
					role: "Helps Erin",
					instructions: "Help Erin.",
				}),
			)
			const chat = talk(erin.session, named.id)
			const first = await chat.message("hello")
			assert.equal(first.delivery, "started")
			const view = await chat.rested()
			assert.equal(view.chat.bot, named.id)
			// The same Bot and person always use the same Chat.
			const again = await chat.message("hello again")
			assert.equal(again.chat, first.chat)
			await chat.rested()
			// Frank cannot read the Chat of Erin.
			assert.equal(
				(await send(frank.session, "/v1/chats/" + first.chat)).status,
				404,
			)
		} finally {
			await host.close()
		}
	},
)
