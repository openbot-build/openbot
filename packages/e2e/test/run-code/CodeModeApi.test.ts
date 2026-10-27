import { Execution } from "@openbot-build/domain"
import { PgClient } from "@effect/sql-pg"
import { assert, it } from "@effect/vitest"
import {
	type ChatView,
	CodeRunsApi,
	ConnectionsApi,
	RequestsApi,
	UserTokensApi,
} from "@openbot-build/api"
import { AppHost } from "@openbot-build/openbot"
import {
	Apps,
	AppFixture as Fixture,
	BrowserHost,
	Caller,
	Messages,
} from "@openbot-build/openbot/testing"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import {
	Array as Arr,
	Effect,
	Layer,
	Option,
	pipe,
	Ref,
	Schedule,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, type Prompt, Response } from "effect/ai"

const { message, settled } = Messages
type Send = Messages.Send

/** The Chat did not give the answer that the test waits for. */
class NoAnswer extends Schema.TaggedError<
	NoAnswer,
	{ readonly brand: unique symbol }
>()("NoAnswer", { text: Schema.String }) {
	override get message() {
		return "The Chat did not answer with " + this.text
	}
}

/** Gives a value as JSON text. */
const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

/** A connection draft, with only the fields that the test reads. */
const Draft = Schema.Struct({ id: Schema.String, revision: Schema.Int })

/** An App connection, with only the fields that the test reads. */
const Connection = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	revision: Schema.Int,
})

/** An App operation, with only the field that the test reads. */
const Operation = Schema.Struct({ id: Schema.String })

const isUser = (message: Prompt.Message): message is Prompt.UserMessage =>
	message.role === "user"

/** The text parts of a message of the person, as one text. */
const textOf = (message: Prompt.UserMessage) =>
	pipe(
		message.content,
		Arr.filter((part) => part.type === "text"),
		Arr.map((part) => part.text),
		Arr.join(""),
	)

it.layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"Code Mode sends App calls through the same checks, goes on after decisions, and never sends a call twice",
		() =>
			Effect.gen(function* () {
				const publisher = yield* Fixture.start({ capabilities: true })
				const observed = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>(
					[],
				)
				const usage = {
					inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 5, text: 5, reasoning: 0 },
				}
				const answer = (
					text: string,
				): Stream.Stream<Response.StreamPartEncoded> =>
					Stream.make(
						Response.makePart("text-start", { id: "answer" }),
						Response.makePart("text-delta", { id: "answer", delta: text }),
						Response.makePart("text-end", { id: "answer" }),
						Response.makePart("finish", { reason: "stop", usage }),
					)
				const runCode = (
					code: string,
					last: number,
				): Stream.Stream<Response.StreamPartEncoded> =>
					Stream.make(
						Response.makePart("tool-call", {
							id: "code-call-" + last,
							name: "openbot_run_code",
							params: { code, reason: "The test needs it." },
							providerExecuted: false,
						}),
						Response.makePart("finish", { reason: "tool-calls", usage }),
					)
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
									Option.map(textOf),
									Option.getOrElse(() => ""),
								)
								// A message from OpenBot, such as the end of a program, is not a program.
								if (Str.startsWith("[OpenBot]")(input)) return answer(input)
								yield* Ref.update(
									observed,
									Arr.append(Arr.map(tools, (tool) => tool.name)),
								)
								const result = pipe(
									Arr.drop(prompt.content, last + 1),
									Arr.flatMap((message) =>
										message.role === "tool"
											? Arr.filter(
													message.content,
													(part) => part.type === "tool-result",
												)
											: [],
									),
									Arr.last,
								)
								// A tool result comes from JSON, so it always becomes JSON text again.
								if (Option.isSome(result))
									return answer(
										yield* Effect.orDie(jsonText(result.value.result)),
									)
								if (
									!Arr.some(tools, (tool) => tool.name === "openbot_run_code")
								)
									return answer("Code Mode is not available.")
								return runCode(input, last)
							}),
						),
				})
				const publicOrigin = "https://openbot.fixture.test"
				const host = yield* BrowserHost.start({
					publicOrigin,
					model,
					// Reading documents needs no decision. Writing to the board does.
					appReadRules: [
						{ cardUrl: publisher.origin + "/card", tool: "read_document" },
					],
					codeMode: {
						enabled: true,
						timeoutMs: 5_000,
						memoryMb: 32,
						outputBytes: 64 * 1024,
					},
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
				const alice = yield* host.login("code-alice")
				const bob = yield* host.login("code-bob")
				const bot = yield* host.defaultBot(alice.session)
				yield* host.defaultBot(bob.session)
				const address = yield* host.address
				const call = Caller.withCookie({ address, publicOrigin })
				const post = (path: string, body: unknown, session = alice.session) =>
					call(session, path, "POST", body)
				const read = (path: string, session = alice.session) =>
					call(session, path)
				const asAlice: Send = (path, method, payload) =>
					call(alice.session, path, method, payload)
				for (const [path, connectionName, account] of [
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
						name: connectionName,
						confirmed: true,
					})
					assert.strictEqual(response.status, 201, yield* response.text)
				}
				/** The Chat of the programs. The first program starts it. */
				const chat = yield* Ref.make("")
				/** Waits for the requests of the Chat that wait for a decision. */
				const pending = Effect.flatMap(Ref.get(chat), (id) =>
					Effect.flatMap(
						read("/v1/requests?status=pending"),
						Caller.json(Schema.Array(RequestsApi.CapabilityRequest)),
					).pipe(
						Effect.map((list) =>
							Arr.filter(list, (entry) => entry.chat === id),
						),
					),
				).pipe(
					Effect.repeat({
						until: Arr.isReadonlyArrayNonEmpty,
						schedule: Schedule.spaced("25 millis"),
						times: 199,
					}),
				)
				/** Waits until the Chat is at rest and its last answer has this text. */
				const answered = (text: RegExp) =>
					Effect.flatMap(Ref.get(chat), (id) => settled(asAlice, id)).pipe(
						Effect.flatMap((view) =>
							Effect.map(jsonText(view.response), (response) =>
								Option.liftPredicate(view, () => text.test(response)),
							),
						),
						Effect.repeat({
							until: Option.isSome,
							schedule: Schedule.spaced("25 millis"),
							times: 199,
						}),
						Effect.flatMap(
							Effect.fromOption(() => NoAnswer.make({ text: String(text) })),
						),
					)
				const start = Effect.fn("CodeMode.start")(function* (code: string) {
					const receipt = yield* message(asAlice, bot, code)
					const current = yield* Ref.updateAndGet(chat, (id) =>
						id === "" ? receipt.chat : id,
					)
					assert.strictEqual(receipt.chat, current)
					assert.ok(receipt.executionId.length > 0)
					return yield* settled(asAlice, current)
				})
				const decide = Effect.fn("CodeMode.decide")(function* (
					decision: "allow" | "deny",
				) {
					const [request] = yield* pending
					assert.ok(request, "A call of the program waits for a decision.")
					const decided = yield* post("/v1/requests/" + request.id, {
						commandKey: `answer-15410:${request.id}`,
						expected: request.revision,
						decision,
					})
					assert.strictEqual(decided.status, 202, yield* decided.text)
					return request
				})
				/** While a call waits, the Turn ends, and the Bot reads that the call is pending. */
				const paused = Effect.fn("CodeMode.paused")(function* (view: ChatView) {
					assert.strictEqual(view.status, "Completed")
					assert.strictEqual(view.open.requests, 1)
					assert.match(yield* jsonText(view.response), /background/)
				})

				// Reads that need no decision run at once, and together.
				const reads = yield* start(`
				const [a, b] = await Promise.all([
					apps.work_documents.read_document({ id: "one" }),
					apps.work_documents.read_document({ id: "two" }),
				])
				console.log("read", a.structuredContent.id)
				return [a.structuredContent.text, b.structuredContent.text]
			`)
				assert.strictEqual(
					reads.response?.status,
					"completed",
					yield* jsonText(reads.response),
				)
				const readText = yield* jsonText(reads.response)
				assert.match(readText, /Document content one/)
				assert.match(readText, /Document content two/)
				assert.strictEqual(yield* publisher.businessCalls, 2)
				assert.ok(
					Option.exists(
						Arr.head(yield* Ref.get(observed)),
						Arr.contains("openbot_code_api"),
					),
				)

				// A denied call reaches the program as an error that it can catch.
				const deniedTurn = yield* start(`
				try {
					await apps.personal_documents.write_board({ id: "draft", text: "Never sent" })
					return "sent"
				} catch (error) {
					return error.name
				}
			`)
				yield* paused(deniedTurn)
				const denial = yield* decide("deny")
				assert.strictEqual(denial.code?.index, 0)
				assert.match(denial.code?.code ?? "", /write_board/)
				assert.strictEqual(
					denial.app?.source.connectionName,
					"Personal documents",
				)
				// The program goes on in the background. Its result comes back as a message.
				yield* answered(/AppCallDenied/)
				assert.strictEqual((yield* publisher.writes).length, 0)
				assert.strictEqual(yield* publisher.businessCalls, 2)

				// The program waits for the write. After the decision it runs again in the
				// background, and the read before the write is not sent again.
				const waiting = yield* start(`
				const document = await apps.work_documents.read_document({ id: "plan" })
				await apps.personal_documents.write_board({
					id: "plan",
					text: document.structuredContent.text,
				})
				return "written"
			`)
				yield* paused(waiting)
				assert.strictEqual(yield* publisher.businessCalls, 3)
				assert.strictEqual((yield* publisher.writes).length, 0)
				const allowed = yield* decide("allow")
				assert.strictEqual(allowed.code?.index, 1)
				const written = yield* answered(/written/)
				assert.strictEqual(
					written.response?.status,
					"completed",
					yield* jsonText(written.response),
				)
				assert.strictEqual(yield* publisher.businessCalls, 4)
				assert.deepStrictEqual(yield* publisher.writes, [
					{ account: "Personal", text: "Document content plan" },
				])

				// A saved binding cannot use a connection that is disabled during approval.
				const changing = yield* start(`
				const count = Object.keys(apps).length
				if (count === 3) await apps.work_documents.read_document({ id: "check" })
				await apps.personal_documents.write_board({ id: "check", text: "Never sent" })
				return count
			`)
				yield* paused(changing)
				assert.strictEqual(yield* publisher.businessCalls, 5)
				const connections = yield* Effect.flatMap(
					read("/v1/connections"),
					Caller.json(Schema.Array(Connection)),
				)
				const workConnection = Arr.findFirst(
					connections,
					(connection) => connection.name === "Personal documents",
				)
				assert.ok(Option.isSome(workConnection), yield* jsonText(connections))
				const disabled = yield* call(
					alice.session,
					"/v1/connections/" + workConnection.value.id,
					"PUT",
					{
						commandKey: `disable-code:${workConnection.value.id}`,
						revision: workConnection.value.revision,
						name: workConnection.value.name,
						enabled: false,
					},
				)
				const disableReceipt = yield* Caller.json(
					Execution.Receipt,
					202,
				)(disabled)
				const disableResult = yield* read(
					`/v1/connections/${workConnection.value.id}/executions/${disableReceipt.executionId}`,
				).pipe(
					Effect.flatMap(Caller.json(ConnectionsApi.ConnectionExecution)),
					Effect.repeat({
						until: (result) => Execution.isTerminal(result.execution.status),
						schedule: Schedule.spaced("20 millis"),
					}),
					Effect.timeout("30 seconds"),
				)
				assert.equal(
					disableResult.execution.status,
					"completed",
					yield* jsonText(disableResult),
				)
				yield* decide("allow")
				yield* answered(/Failed/)
				assert.strictEqual(yield* publisher.businessCalls, 5)
				assert.strictEqual((yield* publisher.writes).length, 1)

				// People read the programs of their Chats with the cookie or with a token.
				const chatId = yield* Ref.get(chat)
				const runs = yield* Effect.flatMap(
					read("/v1/chats/" + chatId + "/code-runs"),
					Caller.json(Schema.Array(CodeRunsApi.ExecutionView)),
				)
				assert.deepStrictEqual(
					Arr.map(runs, (run) => [run.status, run.calls.length]),
					[
						["completed", 2],
						["completed", 1],
						["completed", 2],
						["failed", 2],
					],
				)
				const writtenRun = runs[2]
				assert.ok(writtenRun)
				assert.deepStrictEqual(
					Arr.map(writtenRun.calls, (entry) => entry.app?.result?._tag),
					["Completed", "Completed"],
				)
				assert.strictEqual(
					runs[1]?.calls[0]?.app?.failure?.category,
					"forbidden",
				)
				const token = yield* Effect.flatMap(
					post("/v1/user/tokens", { name: "code runs" }),
					Caller.json(UserTokensApi.CreatedToken),
				)
				const withToken = yield* Caller.withToken(address)(
					token.secret,
					"/v1/code-runs/" + writtenRun.id,
				)
				assert.strictEqual(withToken.status, 200, yield* withToken.text)
				assert.strictEqual(
					(yield* Caller.json(CodeRunsApi.ExecutionView)(withToken)).id,
					writtenRun.id,
				)
				assert.strictEqual(
					(yield* read("/v1/code-runs/" + writtenRun.id, bob.session)).status,
					404,
				)
				// Each App call of a program is also an App operation.
				const operations = yield* Effect.flatMap(
					read("/v1/chats/" + chatId + "/app-operations"),
					Caller.json(Schema.Array(Operation)),
				)
				assert.strictEqual(
					Arr.filter(operations, (operation) =>
						Arr.some(runs, (run) =>
							Arr.some(run.calls, (call) => call.app?.id === operation.id),
						),
					).length,
					7,
				)
				// The stored programs are sealed, like App operations.
				yield* host.run(
					Effect.gen(function* () {
						const sql = yield* PgClient.PgClient
						const rows = yield* sql<{
							readonly body: string
						}>`select input as body from openbot_executions where resource_kind = 'CodeRun'`
						assert.strictEqual(rows.length, 4)
						for (const row of rows) {
							assert.strictEqual(
								Str.includes("Document content")(row.body),
								false,
							)
							assert.strictEqual(Str.includes("write_board")(row.body), false)
						}
					}),
				)

				// When the platform turns Code Mode off, the Bot does not get its tools.
				yield* Apps.setCodeModeEnabled(host, false)
				const off = yield* start("return 1")
				assert.match(
					yield* jsonText(off.response),
					/Code Mode is not available/,
				)
				const lastTools = Arr.last(yield* Ref.get(observed))
				assert.ok(Option.isSome(lastTools))
				assert.strictEqual(
					Arr.contains(lastTools.value, "openbot_run_code"),
					false,
				)
			}),
		// This test runs four programs, approvals and HTTP servers with real time.
		{ timeout: 90000 },
	)
})
