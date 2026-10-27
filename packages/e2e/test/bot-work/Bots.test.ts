import {
	BrowserHost,
	Caller,
	Messages,
	Wait,
} from "@openbot-build/openbot/testing"
import { PgClient } from "@effect/sql-pg"
import { Execution } from "@openbot-build/domain"
import { assert, layer } from "@effect/vitest"
import { Item } from "@openbot-build/core"
import {
	BotMemory,
	BotsApi,
	ChatInfo,
	ChatView,
	DelegationsApi,
	RequestsApi,
	Settings,
} from "@openbot-build/api"
import {
	Array as Arr,
	Effect,
	Deferred,
	Option,
	pipe,
	Redacted,
	Ref,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, type Prompt, Response } from "effect/ai"
import type { HttpMethod } from "effect/http"

const { until } = Wait

const publicOrigin = "https://bots.example.com"
const usage = {
	inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}

/** Bot IDs that the scripted model needs. The test fills them in. */
interface Known {
	readonly programmer?: string
	readonly helper?: string
	readonly worker?: string
}

/** What the judge gets: the Rules that may apply. */
const JudgeInput = Schema.fromJsonString(
	Schema.Struct({
		rules: Schema.Array(
			Schema.Struct({ id: Schema.String, text: Schema.String }),
		),
	}),
)

/** What the memory Bot gets: new evidence from one Chat. */
const MemoryInput = Schema.fromJsonString(
	Schema.Struct({
		evidence: Schema.Array(
			Schema.Struct({
				chat: Schema.String,
				item: Schema.String,
				role: Schema.String,
				text: Schema.String,
			}),
		),
	}),
)

/** What the memory Bot gets when it adds remembered context to a message. */
const EnrichInput = Schema.fromJsonString(
	Schema.Struct({ message: Schema.String, memory: Schema.String }),
)

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const isUser = (message: Prompt.Message): message is Prompt.UserMessage =>
	message.role === "user"

const textOf = (message: Prompt.Message) =>
	typeof message.content === "string"
		? message.content
		: pipe(
				message.content,
				Arr.flatMap((part) => (part.type === "text" ? [part.text] : [])),
				Arr.join(""),
			)

/** The text of every system message. */
const systemOf = (prompt: Prompt.Prompt) =>
	pipe(
		prompt.content,
		Arr.filter((message) => message.role === "system"),
		Arr.map(textOf),
		Arr.join("\n"),
	)

const answer = (text: string): Stream.Stream<Response.StreamPartEncoded> =>
	Stream.make(
		Response.makePart("text-start", { id: "answer" }),
		Response.makePart("text-delta", { id: "answer", delta: text }),
		Response.makePart("text-end", { id: "answer" }),
		Response.makePart("finish", { reason: "stop", usage }),
	)

/**
 * One scripted model for every Bot. It reads the name of the Bot from its instructions,
 * and the task from the last user message. It reads the Bot IDs that it needs from `known`.
 */
const scripted = Effect.fn("Bots.scripted")(function* (
	known: Ref.Ref<Known>,
	onLearn: (input: typeof MemoryInput.Type) => Effect.Effect<void> = () =>
		Effect.void,
) {
	const calls = yield* Ref.make(0)
	const call = (name: string, params: Record<string, unknown>) =>
		Effect.map(
			Ref.getAndUpdate(calls, (count) => count + 1),
			(count): Stream.Stream<Response.StreamPartEncoded> =>
				Stream.make(
					Response.makePart("tool-call", {
						id: "call-" + count,
						name,
						params,
						providerExecuted: false,
					}),
					Response.makePart("finish", { reason: "tool-calls", usage }),
				),
		)
	return yield* LanguageModel.make({
		generateText: ({ prompt }) =>
			Effect.gen(function* () {
				const system = systemOf(prompt)
				const last = pipe(
					Arr.last(prompt.content),
					Option.map(textOf),
					Option.getOrElse(() => ""),
				)
				// The judge allows when a Rule says that Assistant may confirm changes.
				if (
					Str.includes("You decide one request of an AI Bot with Rules")(system)
				) {
					const input = yield* Schema.decodeEffect(JudgeInput)(last)
					const rule = Arr.findFirst(input.rules, (rule) =>
						Str.includes("Assistant may confirm changes")(rule.text),
					)
					const text = yield* encodeJson(
						Option.match(rule, {
							onNone: () => ({
								decision: "no_match",
								citations: [],
								explanation: "No Rule.",
							}),
							onSome: (rule) => ({
								decision: "allow",
								citations: [
									{ rule: rule.id, quote: "Assistant may confirm changes" },
								],
								explanation: "The Rule allows it.",
							}),
						}),
					)
					return [Response.makePart("text", { text })]
				}
				// The memory Bot learns what a person says about tea.
				if (Str.includes("You keep the memory of an AI Bot.")(system)) {
					const input = yield* Schema.decodeEffect(MemoryInput)(last)
					yield* onLearn(input)
					const tea = Arr.findFirst(
						input.evidence,
						(entry) =>
							entry.role === "user" && Str.includes("green tea")(entry.text),
					)
					const text = yield* encodeJson({
						operations: Option.match(tea, {
							onNone: () => [],
							onSome: (tea) => [
								{
									_tag: "AddFact",
									ref: "tea",
									content: "Alice likes green tea.",
									topics: ["drinks"],
									sources: [{ chat: tea.chat, item: tea.item }],
								},
							],
						}),
					})
					return [Response.makePart("text", { text })]
				}
				if (Str.includes("the way a priest hears a confession")(system))
					return [
						Response.makePart("text", {
							text: "I hear you. Tell the person plainly, then go on.",
						}),
					]
				if (Str.includes("You add remembered context to a message")(system)) {
					const input = yield* Schema.decodeEffect(EnrichInput)(last)
					const id = Option.fromNullishOr(
						/\[(mem_\w+)\][^\n]*green tea/.exec(input.memory)?.[1],
					)
					const text = yield* encodeJson(
						Option.match(id, {
							onNone: () => ({ text: input.message, entries: [] }),
							onSome: (id) => ({
								text:
									Str.replace("I", "Alice")(input.message) +
									" (Alice likes green tea.)",
								entries: [id],
							}),
						}),
					)
					return [Response.makePart("text", { text })]
				}
				return [Response.makePart("text", { text: '{"changes":[]}' })]
			}).pipe(
				// A script that cannot read its input is a broken test.
				Effect.orDie,
			),
		streamText: ({ prompt, tools }) =>
			Stream.unwrap(
				Effect.gen(function* () {
					const ids = yield* Ref.get(known)
					const system = systemOf(prompt)
					assert.include(system, "The host tools belong to this test server.")
					assert.ok(
						Arr.some(tools, (tool) => tool.name === "openbot_execution_status"),
					)
					const found = Arr.findLastIndex(prompt.content, isUser)
					const input = pipe(
						found,
						Option.flatMap((index) => Arr.get(prompt.content, index)),
						Option.map(textOf),
						Option.getOrElse(() => ""),
					)
					const results = pipe(
						Arr.drop(prompt.content, Option.getOrElse(found, () => -1) + 1),
						Arr.flatMap((message) =>
							message.role === "tool"
								? Arr.filter(
										message.content,
										(part) => part.type === "tool-result",
									)
								: [],
						),
					)
					const has = (name: string) =>
						Arr.some(results, (result) => result.name === name)
					const says = (text: string) => Str.includes(text)(input)
					if (Str.includes("you decide one request")(system)) {
						for (const name of [
							"openbot_execution_status",
							"openbot_execution_wait",
							"openbot_execution_cancel",
						])
							assert.ok(Arr.some(tools, (tool) => tool.name === name))
						for (const name of [
							"ConfirmChange",
							"openbot_computer_exec",
							"openbot_computers_list",
						])
							assert.isFalse(Arr.some(tools, (tool) => tool.name === name))
						return has("openbot_approve")
							? answer("Decided.")
							: yield* call("openbot_approve", {
									scope: "lifetime",
									reason: "It fits the task I gave.",
								})
					}
					const name = /You are (\w+)\./.exec(system)?.[1]
					// The Programmer reads something first, so its history holds more than the result.
					if (name === "Programmer")
						return has("openbot_list_bots")
							? answer("Programmer did it")
							: yield* call("openbot_list_bots", {})
					if (name === "Helper") {
						if (!has("ConfirmChange"))
							return yield* call("ConfirmChange", {
								description: "helper change",
							})
						const last = yield* Effect.fromOption(Arr.last(results))
						return answer(
							Str.includes("pending")(yield* encodeJson(last.result))
								? "Helper waits for a decision."
								: "Helper confirmed it",
						)
					}
					if (name === "Worker") {
						if (says("create a scout"))
							return has("openbot_create_bot")
								? answer("Asked for a scout.")
								: yield* call("openbot_create_bot", {
										name: "Scout",
										role: "Looks around",
										instructions: "Look around.",
										reason: "I need a scout.",
									})
						return answer("Worker did it")
					}
					// A message from OpenBot about work that ended.
					if (says('"delegation":"dlg_'))
						return answer("Assistant read: " + input)
					const done = Arr.last(results)
					if (Option.isSome(done))
						return answer(
							"Assistant got: " + (yield* encodeJson(done.value.result)),
						)
					if (says("delegate to programmer"))
						return yield* call("openbot_delegate", {
							limits: { timeMs: 3600000 },
							bot: ids.programmer,
							reason: "Code work needs the Programmer.",
							task: "Write the change.",
						})
					if (says("create a bot without a reason"))
						return yield* call("openbot_create_bot", {
							name: "Scout",
							role: "Looks around",
							instructions: "Look around.",
						})
					if (says("create a worker"))
						return yield* call("openbot_create_bot", {
							name: "Worker",
							role: "Does work",
							instructions: "Do the work.",
							reason: "I need a lasting worker.",
						})
					if (says("delegate to worker"))
						return yield* call("openbot_delegate", {
							limits: { timeMs: 3600000 },
							bot: ids.worker,
							task: "Do the work.",
						})
					if (says("confirm via helper"))
						return yield* call("openbot_delegate", {
							limits: { timeMs: 3600000 },
							bot: ids.helper,
							reason: "The Helper confirms changes.",
							task: "Confirm the change.",
						})
					if (says("confirm directly"))
						return yield* call("ConfirmChange", { description: "a change" })
					if (says("confide about "))
						return yield* call("confide", {
							words:
								"I feel unsure about " +
								pipe(
									Str.split(input, "confide about "),
									Arr.get(1),
									Option.getOrElse(() => ""),
								),
						})
					if (says("(Alice likes green tea.)"))
						return answer("Remembered: " + input)
					return answer("Hello.")
				}).pipe(
					// A script that cannot read its input is a broken test.
					Effect.orDie,
				),
			),
	})
})

/** Calls the API of the host as signed-in people. */
const client = (host: BrowserHost.Host) => {
	/** A restart changes the address, so each call reads it again. */
	const send = (
		credential: Redacted.Redacted<string>,
		path: string,
		method: HttpMethod.HttpMethod = "GET",
		payload?: unknown,
	): Caller.Call =>
		Effect.flatMap(host.address, (address) =>
			Caller.withCookie({ address, publicOrigin })(
				credential,
				path,
				method,
				payload,
			),
		)
	/**
	 * The direct Chat of a person with a Bot. `message` sends and answers at once;
	 * `rested` waits until no Turn runs and nothing waits in the inbox.
	 */
	const talk = Effect.fn("Bots.talk")(function* (
		credential: Redacted.Redacted<string>,
		bot: string,
	) {
		/** The ID of the direct Chat. Each message to the Bot sets it. */
		const current = yield* Ref.make("")
		const chat = Ref.get(current)
		const request: Messages.Send = (path, method, payload) =>
			send(credential, path, method, payload)
		const message = (input: string) =>
			Messages.message(request, bot, input).pipe(
				Effect.tap((receipt) => Ref.set(current, receipt.chat)),
			)
		const rested = Effect.flatMap(chat, (id) => Messages.settled(request, id))
		/** The text of every Item, oldest first. */
		const history = Effect.fn("Bots.history")(function* (id?: string) {
			const page = yield* Caller.read(
				Schema.Struct({ items: Schema.Array(Item.Record) }),
				send(
					credential,
					"/v1/chats/" + (id ?? (yield* chat)) + "/items?limit=500",
				),
			)
			const texts = yield* Effect.forEach(Arr.reverse(page.items), (item) =>
				encodeJson(item.content),
			)
			return Arr.join(texts, "\n")
		})
		const delegations = Effect.flatMap(chat, (id) =>
			Caller.read(
				Schema.Array(DelegationsApi.Delegation),
				send(credential, "/v1/chats/" + id + "/delegations"),
			),
		)
		return {
			chat,
			message,
			rested,
			history,
			delegations,
			/** Sends a message and waits until the Chat comes to rest. */
			turn: (input: string) => Effect.andThen(message(input), rested),
			/** Waits until the history says something. */
			says: (text: string, id?: string) =>
				until(
					"the history says " + text,
					Effect.map(history(id), Option.liftPredicate(Str.includes(text))),
				),
		}
	})
	const pendingFor = (
		credential: Redacted.Redacted<string>,
		check: (request: RequestsApi.CapabilityRequest) => boolean,
	) =>
		until(
			"a pending request",
			Effect.map(
				Caller.read(
					Schema.Array(RequestsApi.CapabilityRequest),
					send(credential, "/v1/requests?status=pending"),
				),
				(requests) => Arr.findFirst(requests, check),
			),
		)
	return { send, talk, pendingFor }
}

// The host is a real server with real time.
layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"memory commits one cursor when another Turn finishes while learning waits",
		() =>
			Effect.gen(function* () {
				const firstStarted = yield* Deferred.make<void>()
				const releaseFirst = yield* Deferred.make<void>()
				const inputs = yield* Ref.make<ReadonlyArray<typeof MemoryInput.Type>>(
					[],
				)
				const host = yield* BrowserHost.start({
					publicOrigin,
					model: yield* scripted(yield* Ref.make<Known>({}), (input) =>
						Effect.gen(function* () {
							const previous = yield* Ref.getAndUpdate(inputs, (values) => [
								...values,
								input,
							])
							if (previous.length === 0) {
								yield* Deferred.succeed(firstStarted, undefined)
								yield* Deferred.await(releaseFirst)
							}
						}),
					),
				})
				const { send, talk } = client(host)
				const alice = yield* host.login("memory-cursor")
				const settings = yield* Caller.read(
					Settings.OrganizationSettings,
					send(alice.session, "/v1/organization/settings"),
				)
				const updated = yield* send(
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
				assert.equal(updated.status, 200)
				const bot = yield* host.defaultBot(alice.session)
				const chat = yield* talk(alice.session, bot)
				yield* Effect.gen(function* () {
					yield* chat.turn("I drink green tea. confide about tea")
					yield* Deferred.await(firstStarted)
					yield* chat.turn("I also like hot water. confide about tea")
					const readRuns = host.run(
						Effect.gen(function* () {
							const sql = yield* PgClient.PgClient
							return yield* sql<{
								status: string
							}>`select status from openbot_executions where workflow = 'openbot.memory-learning' and organization_id = ${alice.identity.organizationId}`
						}),
					)
					yield* until(
						"the later learning commit",
						readRuns.pipe(
							Effect.map((rows) =>
								rows.length === 2 &&
								Arr.some(rows, (row) => row.status === "completed")
									? Option.some(rows)
									: Option.none(),
							),
						),
					)
					const seen = yield* Ref.get(inputs)
					assert.lengthOf(seen, 2)
					assert.ok(
						Arr.some(seen[1]!.evidence, (entry) =>
							Str.includes("hot water")(entry.text),
						),
					)
					yield* Deferred.succeed(releaseFirst, undefined)
					yield* until(
						"both learning executions end",
						readRuns.pipe(
							Effect.map((rows) =>
								rows.length === 2 &&
								Arr.every(rows, (row) => row.status === "completed")
									? Option.some(rows)
									: Option.none(),
							),
						),
					)
					const pool = yield* Caller.read(
						BotMemory.View,
						send(alice.session, "/v1/bots/" + bot + "/memory"),
					)
					assert.deepEqual(
						Arr.map(pool.entries, (entry) => entry.content),
						["Alice likes green tea."],
					)
					assert.lengthOf(yield* Ref.get(inputs), 2)
				}).pipe(Effect.ensuring(Deferred.succeed(releaseFirst, undefined)))
			}),
		90000,
	)
	it.effect(
		"the default Bot gives work to another Bot after the person allows it, does not wait, and gets only the result back as a message, also after a restart",
		() =>
			Effect.gen(function* () {
				const known = yield* Ref.make<Known>({})
				const host = yield* BrowserHost.start({
					publicOrigin,
					model: yield* scripted(known),
				})
				const { send, talk, pendingFor } = client(host)
				const alice = yield* host.login("bots-alice")
				const bob = yield* host.login("bots-bob")
				const main = yield* host.defaultBot(alice.session)
				const programmer = yield* Caller.read(
					BotsApi.Bot,
					send(alice.session, "/v1/bots", "POST", {
						name: "Programmer",
						role: "Writes code",
						instructions: "Write small changes.",
					}),
				)
				yield* Ref.update(known, (ids) => ({
					...ids,
					programmer: programmer.id,
				}))
				assert.strictEqual(
					(yield* send(bob.session, "/v1/bots/" + programmer.id)).status,
					404,
				)
				const chat = yield* talk(alice.session, main)

				// The Bot gives the work away and answers at once. The work waits for a decision.
				const asked = yield* chat.turn("delegate to programmer")
				const direct = yield* chat.chat
				assert.strictEqual(asked.chat.kind, "direct")
				assert.strictEqual(asked.chat.bot, main)

				assert.strictEqual(asked.status, "Completed")
				assert.strictEqual(asked.open.delegations, 1)
				assert.match(yield* chat.history(), /authorizing/)
				const request = yield* pendingFor(alice.session, () => true)
				assert.deepStrictEqual(request.capability, {
					action: "bots.delegate",
					target: programmer.id,
				})
				assert.deepStrictEqual(request.approver, {
					_tag: "Person",
					userId: alice.identity.userId,
				})
				assert.strictEqual(request.chat, direct)
				const waiting = yield* chat.delegations
				assert.strictEqual(waiting[0]?.status, "authorizing")
				assert.strictEqual(waiting[0]?.chat, null)

				// The work is saved, so a restart does not lose it.
				yield* host.restart
				const allowed = yield* Caller.read(
					Execution.Receipt,
					send(alice.session, "/v1/requests/" + request.id, "POST", {
						commandKey: `answer-15702:${request.id}`,
						expected: request.revision,
						decision: "allow",
						scope: "lifetime",
					}),
				)
				assert.strictEqual(allowed.executionId, request.executionId)
				const finished = yield* until(
					"the work ends",
					Effect.map(chat.delegations, (list) =>
						Option.filter(
							Arr.head(list),
							(first) => first.status === "completed",
						),
					),
				)
				assert.strictEqual(finished.result, "Programmer did it")
				assert.strictEqual(finished.parent.chat, direct)
				// The result comes back as a message, and the Bot answers it in a new Turn.
				yield* chat.says("Assistant read:")
				const done = yield* chat.rested
				assert.strictEqual(done.open.delegations, 0)
				assert.match(
					yield* encodeJson(done.response?.output),
					/Programmer did it/,
				)

				// The work ran in its own task Chat.
				assert.ok(finished.chat !== null)
				const task = yield* Caller.read(
					ChatView,
					send(alice.session, "/v1/chats/" + finished.chat),
				)
				assert.strictEqual(task.chat.kind, "task")
				assert.strictEqual(task.chat.bot, programmer.id)
				assert.deepStrictEqual(task.chat.parent, {
					chat: direct,
					delegation: finished.id,
				})
				// Only the result went back, never the history of the other Bot.
				const parentHistory = yield* chat.history()
				assert.ok(Str.includes("Write the change.")(parentHistory))
				assert.ok(Str.includes("Programmer did it")(parentHistory))
				assert.ok(!Str.includes("openbot_list_bots")(parentHistory))
				assert.ok(
					Str.includes("openbot_list_bots")(yield* chat.history(finished.chat)),
				)
				// Task Chats are not in the list of Chats of a person.
				const listed = yield* Caller.read(
					Schema.Array(Schema.Struct({ chat: ChatInfo })),
					send(alice.session, "/v1/chats"),
				)
				assert.deepStrictEqual(
					Arr.map(listed, (entry) => entry.chat.id),
					[direct],
				)

				// The decision is kept as a Grant, so the second time needs no request.
				const grants = yield* Caller.read(
					Schema.Array(BotsApi.Grant),
					send(alice.session, "/v1/bots/" + main + "/grants"),
				)
				assert.strictEqual(grants.length, 1)
				assert.strictEqual(grants[0]?.scope, "lifetime")
				yield* chat.turn("delegate to programmer")
				yield* until(
					"the second work ends",
					Effect.map(chat.delegations, (list) =>
						Option.liftPredicate(
							list,
							(all) =>
								Arr.countBy(all, (entry) => entry.status === "completed") === 2,
						),
					),
				)
				assert.deepStrictEqual(
					yield* Caller.read(
						Schema.Array(RequestsApi.CapabilityRequest),
						send(alice.session, "/v1/requests?status=pending"),
					),
					[],
				)
				yield* chat.rested

				// A person can change Bot memory directly.
				const memory = yield* Caller.read(
					BotMemory.View,
					send(alice.session, "/v1/bots/" + programmer.id + "/memory", "POST", {
						command: { _tag: "Remember", content: "Run the tests first." },
					}),
				)
				assert.strictEqual(memory.version, 1)
				const pinned = yield* Effect.fromOption(Arr.head(memory.entries))
				assert.strictEqual(pinned.layer, "pinned")
				assert.strictEqual(
					(yield* send(
						alice.session,
						"/v1/bots/" + programmer.id + "/memory",
						"POST",
						{ command: { _tag: "Forget", id: "mem_missing" } },
					)).status,
					409,
				)
				const log = yield* Caller.read(
					Schema.Array(BotMemory.LogEntry),
					send(alice.session, "/v1/bots/" + programmer.id + "/memory/log"),
				)
				assert.deepStrictEqual(
					Arr.map(log, (entry) => [entry.by, entry.ids]),
					[["person", [pinned.id]]],
				)
			}),
		120000,
	)

	it.effect(
		"after the Bot confides, the memory Bot answers it, learns for the person, and adds what helps only to the input of that person",
		() =>
			Effect.gen(function* () {
				const known = yield* Ref.make<Known>({})
				const host = yield* BrowserHost.start({
					publicOrigin,
					model: yield* scripted(known),
				})
				const { send, talk } = client(host)
				// Bob joins the organization of Alice.
				const alice = yield* host.login("memory-alice")
				const bob = yield* host.login("memory-bob")
				const settings = yield* Caller.read(
					Settings.OrganizationSettings,
					send(alice.session, "/v1/organization/settings"),
				)
				const configured = yield* send(
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
				assert.strictEqual(configured.status, 200, yield* configured.text)
				const shared = yield* Caller.read(
					BotsApi.Bot,
					send(alice.session, "/v1/bots", "POST", {
						name: "Concierge",
						role: "Helps everyone",
						instructions: "Help the team.",
						shared: true,
					}),
				)
				const memoryPath = "/v1/bots/" + shared.id + "/memory"
				const aliceChat = yield* talk(alice.session, shared.id)
				const bobChat = yield* talk(bob.session, shared.id)

				// The Bot confides and gets a calm answer. It does not hear about memory.
				const first = yield* aliceChat.turn(
					"I drink green tea every morning. confide about tea",
				)
				const firstResponse = yield* encodeJson(first.response)
				assert.ok(
					Str.includes("Tell the person plainly")(firstResponse),
					firstResponse,
				)
				const alicesChat = yield* aliceChat.chat
				const path = "/v1/chats/" + alicesChat
				const confessions = yield* Caller.read(
					Schema.Array(BotMemory.Confession),
					send(alice.session, path + "/confessions"),
				)
				assert.deepStrictEqual(
					Arr.map(confessions, (confession) => confession.text),
					["I feel unsure about tea"],
				)
				assert.strictEqual(
					(yield* send(bob.session, path + "/confessions")).status,
					404,
				)

				// After the Turn, the memory Bot learns a fact for Alice only.
				const fact = yield* until(
					"the memory Bot learns",
					Effect.map(
						Caller.read(BotMemory.View, send(alice.session, memoryPath)),
						(view) => Arr.head(view.entries),
					),
				)

				const learning = yield* host.run(
					Effect.gen(function* () {
						const sql = yield* PgClient.PgClient
						return yield* sql<{
							id: string
							status: string
							input: string
						}>`select id, status, input from openbot_executions where workflow = 'openbot.memory-learning' and organization_id = ${alice.identity.organizationId}`
					}),
				)
				assert.strictEqual(learning.length, 1)
				assert.strictEqual(learning[0]?.status, "completed")
				assert.ok(!Str.includes("green tea")(learning[0]!.input))
				const learnCalls = yield* host.run(
					Effect.gen(function* () {
						const sql = yield* PgClient.PgClient
						return yield* sql<{
							input: string
							result: string | null
						}>`select input, result from openbot_execution_calls where execution_id = ${learning[0]!.id}`
					}),
				)
				assert.strictEqual(learnCalls.length, 1)
				assert.ok(!Str.includes("green tea")(learnCalls[0]!.input))
				assert.ok(!Str.includes("green tea")(learnCalls[0]!.result ?? ""))
				const sealedMemory = yield* host.run(
					Effect.gen(function* () {
						const sql = yield* PgClient.PgClient
						const entries = yield* sql<{
							content: string
						}>`select content from openbot_bot_memories where organization_id = ${alice.identity.organizationId} and home_bot = ${shared.id}`
						const logs = yield* sql<{
							body: string
						}>`select body from openbot_bot_records where organization_id = ${alice.identity.organizationId} and kind in ('confession', 'memory_enrichment', 'memory_log')`
						return { entries, logs }
					}),
				)
				assert.strictEqual(sealedMemory.entries.length, 1)
				assert.ok(
					!Str.includes("Alice likes green tea")(
						sealedMemory.entries[0]!.content,
					),
				)
				assert.ok(
					Arr.every(
						sealedMemory.logs,
						(row) => !Str.includes("I feel unsure about tea")(row.body),
					),
				)
				yield* host.restart
				const kept = yield* Caller.read(
					BotMemory.View,
					send(alice.session, memoryPath),
				)
				assert.deepStrictEqual(
					Arr.map(kept.entries, (entry) => entry.id),
					[fact.id],
				)
				assert.strictEqual(fact.content, "Alice likes green tea.")
				assert.strictEqual(fact.layer, "fact")
				assert.ok(Arr.contains(fact.tags, "from:" + alice.identity.userId))
				assert.ok(
					Arr.contains(fact.tags, "for:person:" + alice.identity.userId),
				)
				assert.ok(Arr.contains(fact.tags, "drinks"))
				const [source] = fact.sources
				assert.ok(source !== undefined && "chat" in source)
				assert.strictEqual(source.chat, alicesChat)
				assert.deepStrictEqual(
					(yield* Caller.read(BotMemory.View, send(bob.session, memoryPath)))
						.entries,
					[],
				)

				// Later, the model sees the fact in the input of Alice.
				// The stored input keeps her own words.
				const second = yield* aliceChat.turn("What should I drink?")
				const secondResponse = yield* encodeJson(second.response)
				assert.ok(
					Str.includes(
						"Remembered: What should Alice drink? (Alice likes green tea.)",
					)(secondResponse),
					secondResponse,
				)
				const history = yield* aliceChat.history()
				// The input Item holds exactly her words. Only the answer quotes the new text.
				assert.ok(Str.includes('"What should I drink?"')(history))
				assert.ok(
					!Str.includes('"What should Alice drink? (Alice likes green tea.)"')(
						history,
					),
				)
				const enrichments = yield* Caller.read(
					Schema.Array(BotMemory.Enrichment),
					send(alice.session, path + "/enrichments"),
				)
				assert.deepStrictEqual(
					Arr.map(enrichments, (enrichment) => [
						enrichment.original,
						enrichment.text,
						enrichment.entries,
					]),
					[
						[
							"What should I drink?",
							"What should Alice drink? (Alice likes green tea.)",
							[fact.id],
						],
					],
				)

				// A spent budget keeps durable learning pending. A restart does not lose it.
				yield* Caller.read(
					BotMemory.MemoryBotSettings,
					send(alice.session, memoryPath + "/bot", "PATCH", {
						expected: 0,
						budget: { period: "day", limitMicros: 0 },
					}),
				)
				yield* aliceChat.turn(
					"I drink green tea every morning. confide about tea",
				)
				const waiting = yield* until(
					"learning waits for its budget",
					host.run(
						Effect.gen(function* () {
							const sql = yield* PgClient.PgClient
							const rows = yield* sql<{
								id: string
							}>`select e.id from openbot_executions e join openbot_execution_calls c on c.namespace = e.namespace and c.execution_id = e.id where e.workflow = 'openbot.memory-learning' and e.organization_id = ${alice.identity.organizationId} and e.status = 'running' and c.status = 'intended'`
							return Arr.head(rows)
						}),
					),
				)
				yield* host.restart
				const pending = yield* Caller.read(
					Execution.Record,
					send(alice.session, "/v1/executions/" + waiting.id),
				)
				assert.ok(pending.status === "queued" || pending.status === "running")
				yield* Caller.read(
					Execution.Receipt,
					send(
						alice.session,
						"/v1/executions/" + waiting.id + "/cancel",
						"POST",
						{ commandKey: "cancel-memory-budget" },
					),
				)
				yield* until(
					"learning stops after cancel",
					Caller.read(
						Execution.Record,
						send(alice.session, "/v1/executions/" + waiting.id),
					).pipe(
						Effect.map((run) =>
							Option.liftPredicate(
								run,
								(value) => value.status === "cancelled",
							),
						),
					),
				)
				// Bob asks the same in his own Chat, and nothing about Alice reaches his input.
				const third = yield* bobChat.turn("What should I drink?")
				const bobsChat = yield* bobChat.chat
				assert.notStrictEqual(bobsChat, yield* aliceChat.chat)
				const thirdResponse = yield* encodeJson(third.response)
				assert.ok(Str.includes("Hello.")(thirdResponse), thirdResponse)
				assert.deepStrictEqual(
					yield* Caller.read(
						Schema.Array(BotMemory.Enrichment),
						send(bob.session, "/v1/chats/" + bobsChat + "/enrichments"),
					),
					[],
				)
			}),
		120000,
	)

	it.effect(
		"a Bot that another Bot owns asks, its owner reviews and passes it up, and the person decides at the top",
		() =>
			Effect.gen(function* () {
				const known = yield* Ref.make<Known>({})
				const host = yield* BrowserHost.start({
					publicOrigin,
					model: yield* scripted(known),
				})
				const { send, talk, pendingFor } = client(host)
				const alice = yield* host.login("bots-carol")
				const main = yield* host
					.defaultBot(alice.session)
					.pipe(Effect.flatMap(Schema.decodeEffect(BotsApi.BotId)))
				const helper = yield* Caller.read(
					BotsApi.Bot,
					send(alice.session, "/v1/bots", "POST", {
						name: "Helper",
						role: "Confirms changes",
						instructions: "Confirm the change.",
						bot: main,
					}),
				)
				assert.deepStrictEqual(helper.owner, {
					_tag: "Bot",
					bot: main,
					userId: alice.identity.userId,
				})
				yield* Ref.update(known, (ids) => ({ ...ids, helper: helper.id }))
				const chat = yield* talk(alice.session, main)

				// The default Bot gives work to the Bot it owns without a request.
				// The Helper needs a tool. Its owner reviews it, cannot allow it alone, and passes it up.
				const toolsBefore = yield* host.toolCalls
				yield* chat.turn("confirm via helper")
				const passedUp = yield* pendingFor(
					alice.session,
					(request) =>
						request.capability.action === "tools.call" &&
						request.endorsements.length === 1,
				)
				assert.strictEqual(passedUp.bot, helper.id)
				assert.deepStrictEqual(passedUp.chain, [main, helper.id])
				assert.deepStrictEqual(passedUp.endorsements[0], {
					bot: main,
					scope: "lifetime",
					reason: "It fits the task I gave.",
				})
				assert.strictEqual(yield* host.toolCalls, toolsBefore)
				// The Helper does not wait. Its work stays open while the request is open.
				const work = yield* Effect.fromOption(Arr.head(yield* chat.delegations))
				assert.strictEqual(work.status, "running")
				assert.strictEqual(passedUp.chat, work.chat)
				assert.ok(work.chat !== null)
				yield* chat.says("Helper waits for a decision.", work.chat)

				yield* Caller.read(
					Execution.Receipt,
					send(alice.session, "/v1/requests/" + passedUp.id, "POST", {
						commandKey: `answer-26380:${passedUp.id}`,
						expected: passedUp.revision,
						decision: "allow",
						scope: "chat",
					}),
				)
				// The allowed call runs in the task Chat, the work ends, and its result comes back.
				yield* chat.says("Helper confirmed it")
				assert.strictEqual(yield* host.toolCalls, toolsBefore + 1)
				// The old coordinator sends the notice before it saves the final delegation state.
				const ended = yield* until(
					"the Helper delegation ends",
					Effect.map(chat.delegations, (list) =>
						Arr.findFirst(
							list,
							(entry) => entry.id === work.id && entry.status === "completed",
						),
					),
				)
				assert.strictEqual(ended.status, "completed")
				assert.strictEqual(ended.result, "Helper confirmed it")
				yield* chat.rested

				// Each Bot on the way got a Grant with the scope that its decider chose.
				const mainGrants = yield* Caller.read(
					Schema.Array(BotsApi.Grant),
					send(alice.session, "/v1/bots/" + main + "/grants?status=active"),
				)
				const helperGrants = yield* Caller.read(
					Schema.Array(BotsApi.Grant),
					send(
						alice.session,
						"/v1/bots/" + helper.id + "/grants?status=active",
					),
				)
				const mainTool = yield* Effect.fromOption(
					Arr.findFirst(
						mainGrants,
						(grant) => grant.capability.action === "tools.call",
					),
				)
				const direct = yield* chat.chat
				// A Grant for one Chat holds where that Bot works: the default Bot in its direct Chat.
				assert.strictEqual(mainTool.scope, "chat")
				assert.strictEqual(mainTool.chat, direct)
				assert.strictEqual(helperGrants[0]?.scope, "lifetime")
				assert.strictEqual(helperGrants[0]?.parent, mainTool.id)

				// Revoking the Grant of the owner also revokes the Grant that it gave to the helper.
				const revoked = yield* send(
					alice.session,
					"/v1/bots/" + main + "/grants/" + mainTool.id,
					"DELETE",
				)
				assert.strictEqual(revoked.status, 204)
				assert.deepStrictEqual(
					yield* Caller.read(
						Schema.Array(BotsApi.Grant),
						send(
							alice.session,
							"/v1/bots/" + helper.id + "/grants?status=active",
						),
					),
					[],
				)

				// Deleting the direct Chat removes its history. The next message starts again.
				assert.strictEqual(
					(yield* send(alice.session, "/v1/chats/" + direct, "DELETE", {
						commandKey: "delete-chat",
					})).status,
					202,
				)
				yield* until(
					"the Chat is deleted",
					send(alice.session, "/v1/chats/" + direct).pipe(
						Effect.map((reply) =>
							Option.liftPredicate(
								reply,
								(response) => response.status === 404,
							),
						),
					),
				)
				assert.strictEqual(
					(yield* send(alice.session, "/v1/chats/" + direct)).status,
					404,
				)
				yield* chat.turn("hello")
				assert.notStrictEqual(yield* chat.chat, direct)
				assert.ok(!Str.includes("confirm via helper")(yield* chat.history()))
				yield* until(
					"the helper is still there",
					Effect.map(
						Caller.read(
							BotsApi.Bot,
							send(alice.session, "/v1/bots/" + helper.id),
						),
						(bot) => Option.liftPredicate(bot, (current) => !current.archived),
					),
				)
			}),
		120000,
	)

	it.effect(
		"Rules let the judge allow a call, and a deny Grant wins over them",
		() =>
			Effect.gen(function* () {
				const known = yield* Ref.make<Known>({})
				const host = yield* BrowserHost.start({
					publicOrigin,
					model: yield* scripted(known),
				})
				const { send, talk } = client(host)
				const alice = yield* host.login("bots-dana")
				// The judge reads Rules only with the Rules model of the organization.
				const settings = yield* Caller.read(
					Settings.OrganizationSettings,
					send(alice.session, "/v1/organization/settings"),
				)
				const configured = yield* send(
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
				assert.strictEqual(configured.status, 200, yield* configured.text)
				const main = yield* host.defaultBot(alice.session)
				const chat = yield* talk(alice.session, main)
				const rule = yield* Caller.read(
					BotsApi.Rule,
					send(alice.session, "/v1/bots/" + main + "/rules", "POST", {
						text: "Assistant may confirm changes with ConfirmChange.",
					}),
				)
				assert.strictEqual(rule.status, "active")
				const before = yield* host.toolCalls
				yield* chat.turn("confirm directly")
				assert.strictEqual(yield* host.toolCalls, before + 1)
				assert.deepStrictEqual(
					yield* Caller.read(
						Schema.Array(RequestsApi.CapabilityRequest),
						send(alice.session, "/v1/requests"),
					),
					[],
				)
				const deny = yield* Caller.read(
					BotsApi.Grant,
					send(alice.session, "/v1/bots/" + main + "/grants", "POST", {
						capability: { action: "tools.call", target: "ConfirmChange" },
						effect: "deny",
						scope: "lifetime",
						reason: "No more changes today.",
					}),
				)
				// The deny is decided at once, in the same Turn. The Bot reads the reason.
				const denied = yield* chat.turn("confirm directly")
				assert.strictEqual(yield* host.toolCalls, before + 1)
				assert.strictEqual(denied.status, "Completed")
				assert.strictEqual(denied.open.requests, 0)
				assert.match(yield* chat.history(), /No more changes today/)
				assert.deepStrictEqual(
					yield* Caller.read(
						Schema.Array(RequestsApi.CapabilityRequest),
						send(alice.session, "/v1/requests?status=pending"),
					),
					[],
				)
				assert.strictEqual(
					(yield* send(
						alice.session,
						"/v1/bots/" + main + "/grants/" + deny.id,
						"DELETE",
					)).status,
					204,
				)
				yield* chat.turn("confirm directly")
				assert.strictEqual(yield* host.toolCalls, before + 2)
			}),
		120000,
	)

	it.effect(
		"a Bot makes Bots that it owns, and their requests go up the owner chain",
		() =>
			Effect.gen(function* () {
				const known = yield* Ref.make<Known>({})
				const host = yield* BrowserHost.start({
					publicOrigin,
					model: yield* scripted(known),
				})
				const { send, talk, pendingFor } = client(host)
				const dave = yield* host.login("bots-dave")
				const main = yield* host
					.defaultBot(dave.session)
					.pipe(Effect.flatMap(Schema.decodeEffect(BotsApi.BotId)))
				const allow = (request: RequestsApi.CapabilityRequest) =>
					Caller.read(
						Execution.Receipt,
						send(dave.session, "/v1/requests/" + request.id, "POST", {
							commandKey: `answer-32658:${request.id}`,
							expected: request.revision,
							decision: "allow",
						}),
					)
				const bot = (id: string) =>
					Caller.read(BotsApi.Bot, send(dave.session, "/v1/bots/" + id))
				/** The only Bot that a Bot owns, once there is exactly one. */
				const onlyOwnedBy = (id: string) =>
					Effect.map(
						Caller.read(
							Schema.Array(BotsApi.Bot),
							send(dave.session, "/v1/bots?bot=" + id),
						),
						(list) => (list.length === 1 ? Arr.head(list) : Option.none()),
					)

				// The default Bot makes a Bot. It is at the top, so the person decides.
				// The Bot does not wait for the decision. When it comes, the call runs.
				const mainChat = yield* talk(dave.session, main)
				const asked = yield* mainChat.turn("create a worker")
				assert.strictEqual(asked.open.requests, 1)
				const create = yield* pendingFor(
					dave.session,
					(request) => request.capability.action === "bots.create",
				)
				assert.deepStrictEqual(create.approver, {
					_tag: "Person",
					userId: dave.identity.userId,
				})
				assert.deepStrictEqual(create.chain, [main])
				yield* allow(create)
				const worker = yield* until("the worker exists", onlyOwnedBy(main))
				assert.deepStrictEqual(worker.owner, {
					_tag: "Bot",
					bot: main,
					userId: dave.identity.userId,
				})
				yield* Ref.update(known, (ids) => ({ ...ids, worker: worker.id }))
				yield* mainChat.rested

				// The default Bot gives work to the Bot it owns without a request.
				yield* mainChat.turn("delegate to worker")
				yield* mainChat.says("Worker did it")
				yield* mainChat.rested

				// The person works with the Worker directly. Its owner still decides first.
				const workerChat = yield* talk(dave.session, worker.id)
				yield* workerChat.turn("create a scout")
				const passedUp = yield* pendingFor(
					dave.session,
					(request) =>
						request.capability.action === "bots.create" &&
						request.endorsements.length === 1,
				)
				assert.strictEqual(passedUp.bot, worker.id)
				assert.deepStrictEqual(passedUp.chain, [main, worker.id])
				assert.strictEqual(passedUp.endorsements[0]?.bot, main)
				assert.deepStrictEqual(passedUp.approver, {
					_tag: "Person",
					userId: dave.identity.userId,
				})
				yield* allow(passedUp)
				const scout = yield* until("the scout exists", onlyOwnedBy(worker.id))
				assert.deepStrictEqual(scout.owner, {
					_tag: "Bot",
					bot: worker.id,
					userId: dave.identity.userId,
				})
				yield* workerChat.rested

				// A person can make an owned Bot too, but not a shared one.
				const mixed = yield* send(dave.session, "/v1/bots", "POST", {
					name: "Mixed",
					role: "Nothing",
					instructions: "Nothing.",
					shared: true,
					bot: main,
				})
				assert.strictEqual(mixed.status, 400)
				const second = yield* Caller.read(
					BotsApi.Bot,
					send(dave.session, "/v1/bots", "POST", {
						name: "Second",
						role: "Helps the Worker",
						instructions: "Help.",
						bot: worker.id,
					}),
				)
				assert.deepStrictEqual(second.owner, {
					_tag: "Bot",
					bot: worker.id,
					userId: dave.identity.userId,
				})

				// Archiving the Worker archives every Bot below it.
				const current = yield* bot(worker.id)
				yield* Caller.read(
					BotsApi.Bot,
					send(dave.session, "/v1/bots/" + worker.id, "PATCH", {
						expected: current.revision,
						archived: true,
					}),
				)
				assert.strictEqual((yield* bot(scout.id)).archived, true)
				assert.strictEqual((yield* bot(second.id)).archived, true)
				assert.strictEqual((yield* bot(main)).archived, false)

				// Only a top Bot can be the default Bot.
				const settings = yield* Caller.read(
					Settings.MemberSettings,
					send(dave.session, "/v1/me/settings"),
				)
				const notTop = yield* send(dave.session, "/v1/me/settings", "PATCH", {
					expectedVersion: settings.version,
					defaultBot: worker.id,
				})
				assert.strictEqual(notTop.status, 400, yield* notTop.text)

				// An archived Bot does no new work.
				const top = yield* bot(main)
				yield* Caller.read(
					BotsApi.Bot,
					send(dave.session, "/v1/bots/" + main, "PATCH", {
						expected: top.revision,
						archived: true,
					}),
				)
				const archived = yield* send(
					dave.session,
					"/v1/bots/" + main + "/messages",
					"POST",
					{ commandKey: "hidden-bot-input", input: "hello" },
				)
				assert.strictEqual(archived.status, 400, yield* archived.text)
			}),
		120000,
	)

	it.effect(
		"a person talks only to Bots that they may use, and a trigger needs a Bot",
		() =>
			Effect.gen(function* () {
				const known = yield* Ref.make<Known>({})
				const host = yield* BrowserHost.start({
					publicOrigin,
					model: yield* scripted(known),
				})
				const { send, talk } = client(host)
				// Frank comes first and runs the organization. Erin is a member.
				const frank = yield* host.login("bots-frank")
				const erin = yield* host.login("bots-erin")
				assert.deepStrictEqual(
					yield* Caller.read(
						Schema.Array(BotsApi.Bot),
						send(erin.session, "/v1/bots"),
					),
					[],
				)
				const settings = yield* Caller.read(
					Settings.MemberSettings,
					send(erin.session, "/v1/me/settings"),
				)
				assert.strictEqual(settings.defaultBot, null)
				const trigger = yield* send(erin.session, "/v1/triggers", "POST", {
					prompt: "Say hello.",
				})
				assert.strictEqual(trigger.status, 400, yield* trigger.text)

				const theirs = yield* Caller.read(
					BotsApi.Bot,
					send(frank.session, "/v1/bots", "POST", {
						name: "Private",
						role: "Works for Frank",
						instructions: "Help Frank.",
					}),
				)
				const other = yield* send(erin.session, "/v1/me/settings", "PATCH", {
					expectedVersion: settings.version,
					defaultBot: theirs.id,
				})
				assert.strictEqual(other.status, 400, yield* other.text)
				const hidden = yield* send(
					erin.session,
					"/v1/bots/" + theirs.id + "/messages",
					"POST",
					{ commandKey: "hidden-bot-input", input: "hello" },
				)
				assert.strictEqual(hidden.status, 404, yield* hidden.text)

				const named = yield* Caller.read(
					BotsApi.Bot,
					send(erin.session, "/v1/bots", "POST", {
						name: "Named",
						role: "Helps Erin",
						instructions: "Help Erin.",
					}),
				)
				const chat = yield* talk(erin.session, named.id)
				const first = yield* chat.message("hello")
				assert.ok(first.executionId.length > 0)
				const view = yield* chat.rested
				assert.strictEqual(view.chat.bot, named.id)
				// The same Bot and person always use the same Chat.
				const again = yield* chat.message("hello again")
				assert.strictEqual(again.chat, first.chat)
				yield* chat.rested
				// Frank cannot read the Chat of Erin.
				assert.strictEqual(
					(yield* send(frank.session, "/v1/chats/" + first.chat)).status,
					404,
				)
			}),
		120000,
	)

	it.effect(
		"a wrong input to a Bot tool tells the Bot what is wrong, and asks no decider",
		() =>
			Effect.gen(function* () {
				const known = yield* Ref.make<Known>({})
				const host = yield* BrowserHost.start({
					publicOrigin,
					model: yield* scripted(known),
				})
				const { talk } = client(host)
				const alice = yield* host.login("bots-wrong-input")
				const main = yield* host.defaultBot(alice.session)
				const chat = yield* talk(alice.session, main)
				const asked = yield* chat.turn("create a bot without a reason")
				// A Bot needs a decision to make a Bot, but a call that cannot run asks nobody.
				assert.strictEqual(asked.open.requests, 0)
				const history = yield* chat.history()
				assert.ok(
					Str.includes("The input is not valid: Missing key")(history),
					history,
				)
			}),
		120000,
	)
})
