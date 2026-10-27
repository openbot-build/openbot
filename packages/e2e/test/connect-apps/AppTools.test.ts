import {
	AppFixture as Fixture,
	BrowserHost,
	Caller,
	Messages,
} from "@openbot-build/openbot/testing"
import { Execution } from "@openbot-build/domain"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import {
	AppExecution,
	ExecutionsApi,
	type ChatView,
	ConnectionsApi,
	RequestsApi,
} from "@openbot-build/api"
import type { Chat } from "@openbot-build/core"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import {
	Array as Arr,
	Deferred,
	Effect,
	Fiber,
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
import { AppHost } from "@openbot-build/openbot"

const { message, settled } = Messages
type Send = Messages.Send

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
const Invocation = Schema.toCodecJson(AppExecution.ExecutionView)
const Invocations = Schema.toCodecJson(Schema.Array(AppExecution.ExecutionView))

/** A page of Chat Items. The Items stay plain JSON, so the test sees all of their fields. */
const ItemsPage = Schema.Struct({
	items: Schema.Array(Schema.Json),
	next: Schema.NullOr(Schema.Int),
})

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
								const DocumentAnswer = Schema.Struct({
									outcome: Schema.TaggedStruct("Completed", {
										result: DocumentResult,
									}),
								})
								const documents = Arr.getSomes(
									Arr.map(toolResults(prompt.content), (part) =>
										Schema.decodeUnknownOption(DocumentAnswer)(part.result),
									),
								)
								const notices = Arr.flatMap(prompt.content, (message) =>
									message.role !== "user"
										? []
										: Arr.getSomes(
												Arr.map(message.content, (part) => {
													if (
														part.type !== "text" ||
														!Str.startsWith("[OpenBot] ")(part.text)
													)
														return Option.none()
													return Schema.decodeOption(
														Schema.fromJsonString(
															Schema.Struct({
																result: Schema.Struct({
																	result: DocumentAnswer,
																}),
															}),
														),
													)(Str.slice(10)(part.text)).pipe(
														Option.map((notice) => notice.result.result),
													)
												}),
											),
								)
								const priorDocument = Arr.head([...documents, ...notices]).pipe(
									Option.map(
										(value) => value.outcome.result.structuredContent.text,
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
					appNetwork: Layer.succeed(AppHost.AppNetwork, {
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
				const run = Effect.fn("AppTools.run")(function* (
					input: string,
					session = alice.session,
					expectUnknown: boolean = false,
					ready?: Deferred.Deferred<void>,
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
					assert.ok(receipt.executionId.length > 0)
					yield* Ref.update(chats, HashMap.set(session, receipt.chat))
					const first = yield* settled(send, receipt.chat)
					const pending = yield* requestsFor(receipt.chat, session, first)
					if (pending.length === 0 && ready !== undefined)
						yield* Deferred.succeed(ready, undefined)
					if (asks("covered")) assert.strictEqual(pending.length, 0)
					const view = yield* Effect.reduce(
						asks("hold") ? [] : pending,
						() => first,
						(view, entry) =>
							Effect.gen(function* () {
								// The Turn does not wait for the decision. The call has not run yet.
								assert.strictEqual(view.status, "Completed")
								assert.match(yield* jsonText(view.response), /background/)
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
										commandKey: `answer-12996:${entry.id}`,
										expected: entry.revision,
										decision: asks("reject") ? "deny" : "allow",
									},
									session,
								)
								assert.strictEqual(decided.status, 202, yield* decided.text)
								if (ready !== undefined)
									yield* Deferred.succeed(ready, undefined)
								// The decision comes back to the Chat as a message, and starts a new Turn.
								return expectUnknown
									? view
									: yield* after(receipt.chat, session, view.turn?.id)
							}),
					)
					if (expectUnknown) {
						const unknown = yield* operationsOf(receipt.chat).pipe(
							Effect.repeat({
								until: (rows) =>
									Arr.some(
										rows,
										(row) =>
											row.turn === first.turn?.id &&
											row.status === "outcome_unknown",
									),
								schedule: Schedule.spaced("25 millis"),
								times: 199,
							}),
						)
						assert.ok(
							Arr.some(
								unknown,
								(row) =>
									row.turn === first.turn?.id &&
									row.status === "outcome_unknown",
							),
						)
					}
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
					assert.match(
						yield* jsonText(view.response),
						/Completed/,
						yield* jsonText(view.response),
					)
				}
				const invalid = yield* run("Read with invalid parameters")
				assert.match(yield* jsonText(invalid.response), /Schema/)
				assert.strictEqual(yield* publisher.businessCalls, 1)
				yield* publisher.setInvalidOutput(true)
				const malformed = yield* run(
					"Read malformed output",
					alice.session,
					true,
				)
				assert.match(yield* jsonText(malformed.response), /background/)
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
				assert.strictEqual(
					(yield* publisher.writes).length,
					1,
					yield* jsonText(written.response),
				)
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
					(value) => value.result?._tag === "InputRequired",
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
						commandKey: "wrong-input",
						round,
						responses: { other: { action: "accept" } },
					})).status,
					409,
				)
				yield* host.restart
				assert.strictEqual(yield* publisher.inputStarts, 1)
				const resumeInput = {
					commandKey: "resume-input",
					round,
					responses: {
						consent: { action: "accept", content: { confirmed: true } },
					},
				}
				const resumed = yield* post(operationPath + "/inputs", resumeInput)
				assert.strictEqual(resumed.status, 202, yield* resumed.text)
				const receipt = yield* Caller.json(Execution.Receipt)(resumed)
				assert.equal(receipt.executionId, pendingInput.value.executionId)
				const complete = yield* call(alice.session, operationPath).pipe(
					Effect.flatMap(Caller.json(Invocation)),
					Effect.repeat({
						until: (value) => value.status === "completed",
						schedule: Schedule.spaced("25 millis"),
						times: 199,
					}),
				)
				assert.equal(complete.status, "completed")
				assert.deepEqual(
					yield* post(operationPath + "/inputs", resumeInput).pipe(
						Effect.flatMap(Caller.json(Execution.Receipt, 202)),
					),
					receipt,
				)
				assert.strictEqual(yield* publisher.inputStarts, 1)
				assert.strictEqual(yield* publisher.businessCalls, 4)
				assert.strictEqual(
					(yield* post(operationPath + "/inputs", {
						commandKey: "new-input",
						round,
						responses: {
							consent: { action: "accept", content: { confirmed: true } },
						},
					})).status,
					409,
				)
				yield* publisher.setInputRequired(false)
				yield* publisher.setDropResult(true)
				const unknown = yield* run(
					"Read a result dropped after processing",
					alice.session,
					true,
				)
				yield* publisher.setDropResult(false)
				assert.match(yield* jsonText(unknown.response), /background/)
				assert.strictEqual(yield* publisher.businessCalls, 5)
				const savedUnknown = yield* operationsOf(aliceChat)
				assert.strictEqual(
					Arr.filter(
						savedUnknown,
						(value) => value.status === "outcome_unknown",
					).length,
					2,
				)
				assert.strictEqual(yield* publisher.businessCalls, 5)
				for (const unknown of Arr.filter(
					savedUnknown,
					(value) => value.status === "outcome_unknown",
				)) {
					const events = yield* call(
						alice.session,
						`/v1/executions/${unknown.executionId}/events`,
					).pipe(Effect.flatMap(Caller.json(ExecutionsApi.EventPage)))
					const question = Arr.findLast(
						events.events,
						(event) => event.body._tag === "DecisionNeeded",
					)
					assert.ok(
						Option.isSome(question) &&
							question.value.body._tag === "DecisionNeeded",
					)
					if (
						Option.isNone(question) ||
						question.value.body._tag !== "DecisionNeeded"
					)
						return assert.fail("Expected a decision")
					const stopped = yield* post(
						`/v1/executions/${unknown.executionId}/decisions`,
						{
							commandKey: `stop:${unknown.id}`,
							decisionId: question.value.body.decisionId,
							answer: "stop",
						},
					)
					assert.equal(stopped.status, 200, yield* stopped.text)
				}
				yield* run("ordinary read")
				yield* run("ordinary covered read")
				assert.strictEqual(yield* publisher.businessCalls, 7)
				yield* host.run(
					Effect.gen(function* () {
						const sql = yield* PgClient.PgClient
						// A sequence change stays visible when the failed update rolls back.
						yield* sql`create sequence app_receipt_failures`
						yield* sql`create function reject_app_receipt() returns trigger language plpgsql as $$ begin if NEW.status = 'completed' and NEW.step = 'app:0' then perform nextval('app_receipt_failures'); raise exception 'Fixture receipt persistence failure'; end if; return NEW; end $$`
						yield* sql`create trigger reject_app_receipt before update on openbot_execution_calls for each row execute function reject_app_receipt()`
					}),
				)
				const writeReady = yield* Deferred.make<void>()
				const saving = yield* Effect.forkScoped(
					run(
						"write with receipt storage unavailable",
						alice.session,
						false,
						writeReady,
					),
				)
				// The write wait starts after the first Turn and any needed decision.
				yield* Effect.raceFirst(Deferred.await(writeReady), Fiber.join(saving))
				yield* publisher.writes.pipe(
					Effect.repeat({
						until: (writes) => writes.length === 2,
						schedule: Schedule.spaced("25 millis"),
						times: 199,
					}),
					Effect.raceFirst(
						Fiber.join(saving).pipe(Effect.andThen(publisher.writes)),
					),
				)
				assert.strictEqual((yield* publisher.writes).length, 2)
				const receiptFailed = host.run(
					Effect.gen(function* () {
						const sql = yield* PgClient.PgClient
						const rows = yield* sql<{
							readonly failed: boolean
						}>`select is_called as failed from app_receipt_failures`
						return rows[0]?.failed === true
					}),
				)
				assert.strictEqual(
					yield* receiptFailed.pipe(
						Effect.repeat({
							until: (failed) => failed,
							schedule: Schedule.spaced("25 millis"),
							times: 199,
						}),
						Effect.raceFirst(
							Fiber.join(saving).pipe(Effect.andThen(receiptFailed)),
						),
					),
					true,
				)
				yield* host.run(
					Effect.gen(function* () {
						const sql = yield* PgClient.PgClient
						yield* sql`drop trigger reject_app_receipt on openbot_execution_calls`
						yield* sql`drop function reject_app_receipt()`
						yield* sql`drop sequence app_receipt_failures`
						const rows = yield* sql<{
							readonly body: string
						}>`select input as body from openbot_executions where resource_kind = 'AppCall' union all select result as body from openbot_execution_calls where result is not null`
						for (const row of rows) {
							assert.strictEqual(
								Str.includes("Document content")(row.body),
								false,
							)
							assert.strictEqual(Str.includes("private-Work")(row.body), false)
						}
					}),
				)
				const saved = yield* Fiber.join(saving)
				assert.match(yield* jsonText(saved.response), /Completed/)
				assert.strictEqual((yield* publisher.writes).length, 2)
				assert.strictEqual(yield* publisher.businessCalls, 8)
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
						commandKey: `disable-held:${connection.id}`,
						revision: connection.revision,
						name: connection.name,
						enabled: false,
					},
				)
				assert.strictEqual(disabled.status, 202, yield* disabled.text)
				const disableReceipt = yield* Caller.json(Execution.Receipt)(disabled)
				const disableResult = yield* call(
					alice.session,
					`/v1/connections/${connection.id}/executions/${disableReceipt.executionId}`,
				).pipe(
					Effect.flatMap(
						Caller.json(Schema.toCodecJson(ConnectionsApi.ConnectionExecution)),
					),
					Effect.repeat({
						until: (result) => Execution.isTerminal(result.execution.status),
						schedule: Schedule.spaced("20 millis"),
					}),
					Effect.timeout("30 seconds"),
				)
				assert.strictEqual(
					disableResult.execution.status,
					"completed",
					yield* jsonText(disableResult),
				)
				// The decision came after the connection changed, so the call never runs.
				assert.strictEqual(
					(yield* post("/v1/requests/" + heldRequest.id, {
						commandKey: `answer-21668:${heldRequest.id}`,
						expected: heldRequest.revision,
						decision: "allow",
					})).status,
					202,
				)
				const notRun = yield* after(aliceChat, alice.session, held.turn?.id)
				assert.match(yield* jsonText(notRun.response), /errorId/)
				const refused = Arr.findFirst(
					yield* operationsOf(aliceChat),
					(operation) => operation.turn === held.turn?.id,
				)
				assert.ok(Option.isSome(refused))
				assert.equal(refused.value.failure?.category, "conflict")
				assert.strictEqual(yield* publisher.businessCalls, 8)
				assert.strictEqual(
					(yield* post("/v1/requests/" + heldRequest.id, {
						commandKey: `answer-22046:${heldRequest.id}`,
						expected: heldRequest.revision + 1,
						decision: "allow",
					})).status,
					409,
				)
				// The first result keeps its source and stable execution reference after later work.
				const execution = Option.getOrThrow(
					Arr.head(yield* operationsOf(aliceChat)),
				)
				assert.strictEqual(execution.source.connectionName, "Work documents")
				assert.strictEqual(execution.source.name, "read_later")
				assert.strictEqual(execution.source.kind, "tool")
				assert.strictEqual(execution.result?._tag, "Completed")
				assert.ok(execution.executionId.length > 0)
			}),
		// This test runs many real HTTP Turns and a restart. Parallel suites need more time.
		{ timeout: 180000 },
	)
})
