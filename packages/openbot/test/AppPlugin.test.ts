import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import {
	AppExecution,
	type ChatView,
	ConnectionsApi,
	RequestsApi,
} from "@openbot-build/api"
import type { Chat } from "@openbot-build/core"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import {
	Array as Arr,
	Effect,
	HashMap,
	Layer,
	Match,
	Option,
	pipe,
	type Redacted,
	Ref,
	Schedule,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, type Prompt, Response, Tool } from "effect/ai"
import type { HttpMethod } from "effect/http"
import { AppNetwork } from "../src/apps/AppHost.ts"
import { AppPlugin } from "../src/plugins/apps/AppPlugin.ts"
import * as Fixture from "./AppFixture.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import { message, settled, type Send } from "./Messages.ts"

/** No new Turn ran in a Chat in time. */
class NoNewTurn extends Schema.TaggedError<
	NoNewTurn,
	{ readonly brand: unique symbol }
>()("NoNewTurn", { chat: Schema.String }) {
	override get message() {
		return "No new Turn ran in the Chat " + this.chat
	}
}

/**
 * The API sends each body in the JSON form of its contract schema, with null
 * for an optional value that is not there. These schemas read that form.
 */
const Draft = Schema.toCodecJson(ConnectionsApi.ConnectionDraft)
const Connection = Schema.toCodecJson(ConnectionsApi.Connection)
const Requests = Schema.toCodecJson(Schema.Array(RequestsApi.CapabilityRequest))
const Invocation = Schema.toCodecJson(AppExecution.Invocation)
const Invocations = Schema.toCodecJson(Schema.Array(AppExecution.Invocation))

/** A page of Chat Items. The Items stay plain JSON, so the test sees all of their fields. */
const ItemsPage = Schema.Struct({
	items: Schema.Array(Schema.Json),
	next: Schema.NullOr(Schema.Int),
})

/** The messages of a Chat Item. The content of each message stays plain JSON. */
const ItemMessages = Schema.Struct({
	content: Schema.Struct({
		content: Schema.Array(
			Schema.Struct({ role: Schema.String, content: Schema.Json }),
		),
	}),
})

/** The parts of a tool message. */
const ToolParts = Schema.Array(
	Schema.Struct({
		type: Schema.String,
		result: Schema.optionalKey(Schema.Json),
	}),
)

/** The result of an App tool that read a document. */
const DocumentResult = Schema.Struct({
	structuredContent: Schema.Struct({ text: Schema.String }),
})

/** The JSON text of a value, for a check or the message of a check. */
const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const isUser = (message: Prompt.Message): message is Prompt.UserMessage =>
	message.role === "user"

const usage = {
	inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}

/** A text answer of the fixture model. */
const answer = (text: string): Stream.Stream<Response.StreamPartEncoded> =>
	Stream.make(
		Response.makePart("text-start", { id: "answer" }),
		Response.makePart("text-delta", { id: "answer", delta: text }),
		Response.makePart("text-end", { id: "answer" }),
		Response.makePart("finish", { reason: "stop", usage }),
	)

/** The tool results in some messages, in order. */
const toolResults = (messages: ReadonlyArray<Prompt.Message>) =>
	Arr.flatMap(messages, (message) =>
		Match.value(message).pipe(
			Match.when({ role: "tool" }, (message) =>
				Arr.filter(message.content, (part) => part.type === "tool-result"),
			),
			Match.orElse(() => []),
		),
	)

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"the OpenBot App plugin combines live paged capabilities with caller tools and records real handler results for the current account",
		() =>
			Effect.gen(function* () {
				const publisher = yield* Fixture.start({ capabilities: true })
				const observed = yield* Ref.make<
					ReadonlyArray<{
						readonly input: string
						readonly descriptions: ReadonlyArray<string>
					}>
				>([])
				const model = yield* LanguageModel.make({
					generateText: () =>
						Effect.succeed([
							Response.makePart("text", { text: '{"changes":[]}' }),
						]),
					streamText: ({ prompt, tools }) =>
						Stream.unwrap(
							Effect.gen(function* () {
								const found = Arr.findLastIndex(prompt.content, isUser)
								const last = Option.getOrElse(found, () => -1)
								const input = pipe(
									found,
									Option.flatMap((index) => Arr.get(prompt.content, index)),
									Option.filter(isUser),
									Option.map((message) =>
										pipe(
											message.content,
											Arr.filter((part) => part.type === "text"),
											Arr.map((part) => part.text),
											Arr.join(""),
										),
									),
									Option.getOrElse(() => ""),
								)
								const asks = (text: string) => Str.includes(text)(input)
								yield* Ref.update(
									observed,
									Arr.append({
										input,
										descriptions: Arr.map(
											tools,
											(tool) => tool.description ?? tool.name,
										),
									}),
								)
								const result = Arr.last(
									toolResults(Arr.drop(prompt.content, last + 1)),
								)
								if (Option.isSome(result))
									return answer(
										yield* Effect.orDie(jsonText(result.value.result)),
									)
								// A message from OpenBot, such as a decision, asks for no new App call.
								if (Str.startsWith("[OpenBot]")(input)) return answer(input)
								const wanted = asks("ordinary")
									? "read_document"
									: asks("write")
										? "write_board"
										: asks("resource")
											? "notes://documents/index"
											: asks("template")
												? "notes://documents/{id}"
												: asks("prompt")
													? "review_document"
													: "read_later"
								const selected = Arr.findFirst(tools, (tool) =>
									pipe(
										Option.fromNullishOr(tool.description),
										Option.exists(
											Str.includes(
												(asks("write")
													? "Personal documents"
													: "Work documents") +
													" / " +
													wanted,
											),
										),
									),
								)
								if (Option.isNone(selected))
									return answer("No matching App capability is available.")
								const priorDocument = pipe(
									toolResults(prompt.content),
									Arr.findFirst((part) =>
										pipe(
											Schema.decodeUnknownOption(AppExecution.Result)(
												part.result,
											),
											Option.filter((value) => value._tag === "Completed"),
											Option.flatMap((value) =>
												Schema.decodeUnknownOption(DocumentResult)(
													value.result,
												),
											),
											Option.map((document) => document.structuredContent.text),
										),
									),
									Option.getOrElse(() => ""),
								)
								assert.strictEqual(Tool.isDynamic(selected.value), true)
								const call: Stream.Stream<Response.StreamPartEncoded> =
									Stream.make(
										Response.makePart("tool-call", {
											id: "app-call-" + last,
											name: selected.value.name,
											params: asks("write")
												? { id: "release-plan", text: priorDocument }
												: asks("resource")
													? {}
													: asks("prompt")
														? { subject: "Release" }
														: {
																id: asks("invalid parameters")
																	? 17
																	: "release-plan",
															},
											providerExecuted: false,
										}),
										Response.makePart("finish", {
											reason: "tool-calls",
											usage,
										}),
									)
								return call
							}),
						),
				})
				const publicOrigin = "https://openbot.fixture.test"
				const host = yield* BrowserHost.start({
					publicOrigin,
					model,
					appReadRules: [
						{ cardUrl: publisher.origin + "/card", tool: "read_document" },
					],
					discovery: publisher.discovery,
					appProbe: publisher.probe,
					appNetwork: Layer.succeed(AppNetwork, {
						layer: (owner, origins) =>
							NodeHttpServer.layerUserNetwork({
								owner,
								allowedOrigins: origins,
								ca: publisher.ca,
								allowAddress: (ip) => ip === "127.0.0.1",
							}),
					}),
				})
				const alice = yield* host.login("plugin-alice")
				const bob = yield* host.login("plugin-bob")
				const aliceBot = yield* host.defaultBot(alice.session)
				const bobBot = yield* host.defaultBot(bob.session)
				/** Calls the API as a signed-in person. A restart changes the address of the host. */
				const call = (
					session: Redacted.Redacted<string>,
					path: string,
					method: HttpMethod.HttpMethod = "GET",
					payload?: unknown,
				): Caller.Call =>
					Effect.flatMap(host.address, (address) =>
						Caller.withCookie({ address, publicOrigin })(
							session,
							path,
							method,
							payload,
						),
					)
				const post = (path: string, body: unknown, session = alice.session) =>
					call(session, path, "POST", body)
				const sender =
					(session: Redacted.Redacted<string>): Send =>
					(path, method, payload) =>
						call(session, path, method, payload)
				yield* host.run(
					Effect.scoped(
						Effect.gen(function* () {
							const plugin = (yield* AppPlugin).forOwner(alice.identity)
							yield* plugin.middleware
						}),
					),
				)
				assert.strictEqual((yield* publisher.requests).length, 0)
				for (const [path, name, account] of [
					["/card", "Work documents", "Work"],
					["/second", "Personal documents", "Personal"],
				] as const) {
					const draft = yield* Effect.flatMap(
						post("/v1/connection-drafts", { input: publisher.origin + path }),
						Caller.json(Draft),
					)
					const response = yield* post("/v1/connections", {
						draftId: draft.id,
						revision: draft.revision,
						cardUrl: publisher.origin + path,
						remoteIndex: 0,
						values: {
							"header:X-Account": account,
							"header:X-Secret": "private-" + account,
						},
						name,
						confirmed: true,
					})
					assert.strictEqual(response.status, 201, yield* response.text)
				}
				/** The pending requests of a Chat. */
				const requestsFor = (
					chat: string,
					session: Redacted.Redacted<string>,
					view: ChatView,
				) =>
					view.open.requests === 0
						? Effect.succeed(Arr.empty<RequestsApi.CapabilityRequest>())
						: call(session, "/v1/requests?status=pending").pipe(
								Effect.flatMap(Caller.json(Requests)),
								Effect.map(Arr.filter((entry) => entry.chat === chat)),
								Effect.repeat({
									until: Arr.isReadonlyArrayNonEmpty,
									schedule: Schedule.spaced("25 millis"),
									times: 199,
								}),
							)
				/** Waits until a Turn after `turn` has run, and the Chat is at rest. */
				const after = (
					chat: string,
					session: Redacted.Redacted<string>,
					turn: string | undefined,
				) => {
					const isNew = (view: ChatView) =>
						view.turn !== null && view.turn.id !== turn
					return settled(sender(session), chat).pipe(
						Effect.repeat({
							until: isNew,
							schedule: Schedule.spaced("25 millis"),
							times: 199,
						}),
						Effect.filterOrFail(isNew, () => NoNewTurn.make({ chat })),
					)
				}
				/** The direct Chat of each person with their default Bot. */
				const chats = yield* Ref.make(
					HashMap.empty<Redacted.Redacted<string>, Chat.Id>(),
				)
				const run = Effect.fn("AppPlugin.run")(function* (
					input: string,
					session = alice.session,
				) {
					const asks = (text: string) => Str.includes(text)(input)
					const send = sender(session)
					const known = HashMap.get(yield* Ref.get(chats), session)
					if (Option.isSome(known)) yield* settled(send, known.value)
					const callsBefore = yield* publisher.businessCalls
					const writesBefore = (yield* publisher.writes).length
					const receipt = yield* message(
						send,
						session === alice.session ? aliceBot : bobBot,
						input,
					)
					assert.strictEqual(receipt.delivery, "started")
					yield* Ref.update(chats, HashMap.set(session, receipt.chat))
					const first = yield* settled(send, receipt.chat)
					const pending = yield* requestsFor(receipt.chat, session, first)
					if (asks("covered")) assert.strictEqual(pending.length, 0)
					const view = yield* Effect.reduce(
						asks("hold") ? [] : pending,
						() => first,
						(view, entry) =>
							Effect.gen(function* () {
								// The Turn does not wait for the decision. The call has not run yet.
								assert.strictEqual(view.status, "Completed")
								assert.match(yield* jsonText(view.response), /pending/)
								assert.strictEqual(yield* publisher.businessCalls, callsBefore)
								assert.strictEqual(
									entry.app?.source.connectionName,
									asks("write") ? "Personal documents" : "Work documents",
								)
								if (asks("write"))
									assert.strictEqual(
										(yield* publisher.writes).length,
										writesBefore,
									)
								const decided = yield* post(
									"/v1/requests/" + entry.id,
									{
										expected: entry.revision,
										decision: asks("reject") ? "deny" : "allow",
									},
									session,
								)
								assert.strictEqual(decided.status, 200, yield* decided.text)
								// The decision comes back to the Chat as a message, and starts a new Turn.
								return yield* after(receipt.chat, session, view.turn?.id)
							}),
					)
					if (asks("hold")) return view
					assert.strictEqual(
						view.response?.status,
						"completed",
						yield* jsonText(view.response),
					)
					return view
				})
				/** All Items of a Chat, oldest first, as JSON. */
				const chatItems = (chat: string) =>
					Stream.paginate(Option.none<number>(), (before) =>
						Effect.gen(function* () {
							const response = yield* call(
								alice.session,
								`/v1/chats/${chat}/items?` +
									new URLSearchParams({
										limit: "100",
										...Option.match(before, {
											onNone: () => ({}),
											onSome: (value) => ({ before: String(value) }),
										}),
									}),
							)
							assert.strictEqual(response.status, 200, yield* response.text)
							const page = yield* Caller.json(ItemsPage)(response)
							return [
								page.items,
								Option.map(Option.fromNullishOr(page.next), Option.some),
							] as const
						}),
					).pipe(Stream.runCollect, Effect.map(Arr.reverse))
				/** The App operations of a Chat. */
				const operationsOf = (chat: string) =>
					Effect.flatMap(
						call(alice.session, `/v1/chats/${chat}/app-operations`),
						Caller.json(Invocations),
					)
				yield* run("Read the document")
				assert.strictEqual(yield* publisher.businessCalls, 1)
				const aliceChat = yield* Effect.fromOption(
					HashMap.get(yield* Ref.get(chats), alice.session),
				)
				const firstItems = yield* chatItems(aliceChat)
				const history = yield* jsonText(firstItems)
				assert.match(history, /handler-executed/)
				assert.match(history, /Document content release-plan/)
				assert.match(history, /read_later/)
				assert.match(history, /outputSchema/)
				assert.strictEqual(Str.includes("private-Work")(history), false)
				const [firstCall] = yield* Ref.get(observed)
				assert.ok(firstCall !== undefined)
				assert.ok(
					Arr.contains(
						firstCall.descriptions,
						"Apply the proposed change after approval",
					),
				)
				assert.strictEqual(
					Arr.some(firstCall.descriptions, Str.includes("hidden_action")),
					false,
				)
				assert.strictEqual(
					Arr.filter(firstCall.descriptions, Str.includes("read_later")).length,
					2,
				)
				for (const input of [
					"Read the resource",
					"Read the template",
					"Read the prompt",
				]) {
					const view = yield* run(input)
					assert.match(yield* jsonText(view.response), /Completed/)
				}
				const invalid = yield* run("Read with invalid parameters")
				assert.match(yield* jsonText(invalid.response), /Schema/)
				assert.strictEqual(yield* publisher.businessCalls, 1)
				yield* publisher.setInvalidOutput(true)
				const malformed = yield* run("Read malformed output")
				assert.match(yield* jsonText(malformed.response), /Schema/)
				assert.strictEqual(yield* publisher.businessCalls, 2)
				yield* publisher.setInvalidOutput(false)

				const bobResult = yield* run("Bob read the document", bob.session)
				assert.match(
					yield* jsonText(bobResult.response),
					/No matching App capability/,
				)
				const lastCall = Arr.last(yield* Ref.get(observed))
				assert.ok(Option.isSome(lastCall))
				assert.strictEqual(
					Arr.some(lastCall.value.descriptions, Str.includes("Work documents")),
					false,
				)
				assert.strictEqual(yield* publisher.businessCalls, 2)
				yield* run("reject write to board")
				assert.strictEqual((yield* publisher.writes).length, 0)
				assert.strictEqual(yield* publisher.businessCalls, 2)
				const written = yield* run("write reviewed document to board")
				assert.strictEqual((yield* publisher.writes).length, 1)
				assert.deepStrictEqual((yield* publisher.writes)[0], {
					account: "Personal",
					text: "Document content release-plan",
				})
				assert.match(yield* jsonText(written.response), /Completed/)
				yield* publisher.setInputRequired(true)
				const requiringInput = yield* run("Read requiring input")
				assert.match(yield* jsonText(requiringInput.response), /InputRequired/)
				assert.strictEqual(yield* publisher.inputStarts, 1)
				assert.strictEqual(yield* publisher.businessCalls, 3)
				const pendingInput = Arr.findFirst(
					yield* operationsOf(aliceChat),
					(value) => value.status === "InputRequired",
				)
				assert.ok(Option.isSome(pendingInput))
				const { id: operationId, round } = pendingInput.value
				const operationPath = "/v1/app-operations/" + operationId
				assert.strictEqual(
					(yield* call(bob.session, operationPath)).status,
					404,
				)
				assert.strictEqual(
					(yield* post(operationPath + "/inputs", {
						round,
						responses: { other: { action: "accept" } },
					})).status,
					409,
				)
				yield* host.restart
				assert.strictEqual(yield* publisher.inputStarts, 1)
				const resumed = yield* post(operationPath + "/inputs", {
					round,
					responses: {
						consent: { action: "accept", content: { confirmed: true } },
					},
				})
				assert.strictEqual(resumed.status, 200, yield* resumed.text)
				assert.strictEqual(
					(yield* Caller.json(Invocation)(resumed)).status,
					"Completed",
				)
				assert.strictEqual(yield* publisher.inputStarts, 1)
				assert.strictEqual(yield* publisher.businessCalls, 4)
				assert.strictEqual(
					(yield* post(operationPath + "/inputs", {
						round,
						responses: {
							consent: { action: "accept", content: { confirmed: true } },
						},
					})).status,
					409,
				)
				yield* publisher.setInputRequired(false)
				yield* publisher.setDropResult(true)
				const unknown = yield* run("Read a result dropped after processing")
				yield* publisher.setDropResult(false)
				assert.match(yield* jsonText(unknown.response), /OutcomeUnknown/)
				assert.strictEqual(yield* publisher.businessCalls, 5)
				const savedUnknown = yield* operationsOf(aliceChat)
				assert.strictEqual(
					Arr.filter(savedUnknown, (value) => value.status === "OutcomeUnknown")
						.length,
					2,
				)
				assert.strictEqual(yield* publisher.businessCalls, 5)
				yield* run("ordinary read")
				yield* run("ordinary covered read")
				assert.strictEqual(yield* publisher.businessCalls, 7)
				yield* host.run(
					Effect.gen(function* () {
						const sql = yield* PgClient.PgClient
						yield* sql`create function reject_app_receipt() returns trigger language plpgsql as $$ begin if NEW.status = 'Completed' then raise exception 'Fixture receipt persistence failure'; end if; return NEW; end $$`
						yield* sql`create trigger reject_app_receipt before update on openbot_app_invocations for each row execute function reject_app_receipt()`
					}),
				)
				const saveFailed = yield* run("write with receipt storage unavailable")
				assert.match(yield* jsonText(saveFailed.response), /OutcomeUnknown/)
				assert.strictEqual((yield* publisher.writes).length, 2)
				assert.strictEqual(yield* publisher.businessCalls, 8)
				yield* host.run(
					Effect.gen(function* () {
						const sql = yield* PgClient.PgClient
						yield* sql`drop trigger reject_app_receipt on openbot_app_invocations`
						yield* sql`drop function reject_app_receipt()`
						const rows = yield* sql<{
							readonly body: string
						}>`select body from openbot_app_invocations`
						for (const row of rows) {
							assert.strictEqual(
								Str.includes("Document content")(row.body),
								false,
							)
							assert.strictEqual(Str.includes("private-Work")(row.body), false)
						}
					}),
				)
				const held = yield* run("hold a document operation")
				const [heldRequest] = yield* requestsFor(aliceChat, alice.session, held)
				assert.ok(
					heldRequest?.app !== undefined,
					yield* jsonText({
						status: held.status,
						open: held.open,
						heldRequest,
					}),
				)
				const connection = yield* Effect.flatMap(
					call(
						alice.session,
						"/v1/connections/" + heldRequest.app.source.connectionId,
					),
					Caller.json(Connection),
				)
				const disabled = yield* call(
					alice.session,
					"/v1/connections/" + connection.id,
					"PUT",
					{
						revision: connection.revision,
						name: connection.name,
						enabled: false,
					},
				)
				assert.strictEqual(disabled.status, 200)
				// The decision came after the connection changed, so the call never runs.
				assert.strictEqual(
					(yield* post("/v1/requests/" + heldRequest.id, {
						expected: heldRequest.revision,
						decision: "allow",
					})).status,
					200,
				)
				const notRun = yield* after(aliceChat, alice.session, held.turn?.id)
				assert.match(yield* jsonText(notRun.response), /connection changed/)
				assert.strictEqual(yield* publisher.businessCalls, 8)
				assert.strictEqual(
					(yield* post("/v1/requests/" + heldRequest.id, {
						expected: heldRequest.revision + 1,
						decision: "allow",
					})).status,
					409,
				)
				// The first App result in the Chat. A call that waits for a decision first
				// gets a pending result, and its real result comes later.
				const resultParts = yield* pipe(
					yield* Schema.decodeUnknownEffect(Schema.Array(ItemMessages))(
						firstItems,
					),
					Arr.flatMap((item) => item.content.content),
					Arr.flatMap((entry) =>
						entry.role === "tool"
							? Option.getOrElse(
									Schema.decodeUnknownOption(ToolParts)(entry.content),
									() => [],
								)
							: [],
					),
					Arr.filter((part) => part.type === "tool-result"),
					Effect.filter((part) =>
						Effect.map(
							jsonText(part.result),
							(text) => !Str.includes('"pending"')(text),
						),
					),
				)
				const execution = yield* Schema.decodeUnknownEffect(
					AppExecution.Result,
				)(resultParts[0]?.result)
				assert.strictEqual(execution.source.connectionName, "Work documents")
				assert.strictEqual(execution.source.name, "read_later")
				assert.strictEqual(execution.source.kind, "tool")
			}),
	)
})
