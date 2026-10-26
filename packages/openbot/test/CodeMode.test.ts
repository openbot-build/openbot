import { NodeFileSystem } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, it } from "@effect/vitest"
import {
	type ChatView,
	CodeRunsApi,
	RequestsApi,
	UserTokensApi,
} from "@openbot-build/api"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import {
	Array as Arr,
	Cause,
	Effect,
	Layer,
	Logger,
	Option,
	pipe,
	Ref,
	Schedule,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, type Prompt, Response } from "effect/ai"
import { AppNetwork } from "../src/apps/AppHost.ts"
import type { Binding } from "../src/apps/Bindings.ts"
import { name } from "../src/code/CodeRuns.ts"
import { declarations } from "../src/code/Declarations.ts"
import type { Call } from "../src/code/Protocol.ts"
import { make as makeSandbox, type Program } from "../src/code/Sandbox.ts"
import { Settings } from "../src/settings/Settings.ts"
import * as Fixture from "./AppFixture.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import { message, settled, type Send } from "./Messages.ts"

const limits = {
	timeoutMs: 2_000,
	memoryBytes: 32 * 1024 * 1024,
	outputBytes: 4_096,
}

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
const Operation = Schema.Struct({ callId: Schema.String })

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

/** Runs a program. Each App call answers with its name and arguments. */
const runProgram = (code: string, options: Partial<Program> = {}) =>
	Effect.gen(function* () {
		const sandbox = yield* makeSandbox
		const seen = yield* Ref.make<ReadonlyArray<Call>>([])
		const outcome = yield* sandbox.run(
			{
				code,
				bindings: ["calendar.list", "calendar.add"],
				seed: 7,
				clock: 1_000,
				limits,
				...options,
			},
			(calls) =>
				Effect.map(Ref.update(seen, Arr.appendAll(calls)), () =>
					Option.some(
						Arr.map(calls, (call) => ({
							index: call.index,
							ok: true as const,
							value: JSON.stringify({
								binding: call.binding,
								arguments: JSON.parse(call.arguments),
							}),
						})),
					),
				),
		)
		return { outcome, seen: yield* Ref.get(seen) }
	})

it.layer(NodeFileSystem.layer)((it) => {
	it.effect(
		"a program runs in a closed sandbox and gets its App results in order",
		() =>
			Effect.gen(function* () {
				const { outcome, seen } = yield* runProgram(`
			const [a, b] = await Promise.all([
				apps.calendar.list({ day: 1 }),
				apps.call("calendar.add", { title: "Lunch" }),
			])
			console.log("first", a.arguments.day)
			return { a, b, now: Date.now(), date: new Date().getTime(), random: Math.random() }
		`)
				assert.strictEqual(outcome._tag, "Done")
				assert.deepStrictEqual(
					Arr.map(seen, (call) => [call.index, call.binding]),
					[
						[0, "calendar.list"],
						[1, "calendar.add"],
					],
				)
				if (outcome._tag !== "Done") return
				assert.deepStrictEqual(outcome.logs, ["first 1"])
				const value = outcome.value as Record<string, unknown>
				assert.strictEqual(value["now"], 1_000)
				assert.strictEqual(value["date"], 1_000)
				// The same seed gives the same random numbers in each run.
				const again = yield* runProgram("return Math.random()")
				const other = yield* runProgram("return Math.random()", { seed: 8 })
				assert.strictEqual(again.outcome._tag, "Done")
				assert.strictEqual(other.outcome._tag, "Done")
				if (again.outcome._tag !== "Done" || other.outcome._tag !== "Done")
					return
				assert.strictEqual(again.outcome.value, value["random"])
				assert.notStrictEqual(other.outcome.value, value["random"])
			}),
	)

	it.effect(
		"a defect of the host ends the program as unavailable, and only the log keeps the defect",
		() => {
			let errors: ReadonlyArray<Cause.Cause<unknown>> = []
			const logger = Logger.layer([
				Logger.make((log) => {
					if (log.logLevel === "Error") errors = [...errors, log.cause]
				}),
			])
			return Effect.gen(function* () {
				const sandbox = yield* makeSandbox
				const outcome = yield* sandbox.run(
					{
						code: "await apps.calendar.list({}); return 1",
						bindings: ["calendar.list"],
						seed: 1,
						clock: 1,
						limits,
					},
					() => Effect.die(new Error("The inside state is broken.")),
				)
				assert.deepStrictEqual(outcome, {
					_tag: "Failed",
					reason: "Unavailable",
					message: "OpenBot could not run the program.",
					logs: [],
				})
				assert.strictEqual(errors.length, 1)
				assert.match(
					Arr.join(Arr.map(errors, Cause.pretty), "\n"),
					/The inside state is broken\./,
				)
			}).pipe(Effect.provide(logger))
		},
	)
})

// These tests need real time: the sandbox stops a program after a real
// timeout, and the host runs real servers.
it.layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"a program has no Node.js, and the sandbox stops programs at their limits",
		() =>
			Effect.gen(function* () {
				const closed = yield* runProgram(
					"return [typeof fetch, typeof require, typeof process, typeof setTimeout, typeof globalThis.__openbot_host]",
				)
				assert.deepStrictEqual(
					closed.outcome._tag === "Done" && closed.outcome.value,
					["undefined", "undefined", "undefined", "undefined", "undefined"],
				)
				const cases = [
					["while (true) {}", "Timeout"],
					["const list = []; for (;;) list.push({ a: [1, 2, 3] })", "Memory"],
					["return 'x'.repeat(10000)", "OutputTooLarge"],
					["throw new Error('boom')", "Error"],
					// A value that JSON cannot hold is an error of the program.
					["const a = []; a[0] = a; return a", "Error"],
					["return 10n", "Error"],
					["await new Promise(() => {})", "Error"],
					["return apps.calendar.remove({})", "Error"],
					["return apps.calendar.list('not an object')", "Error"],
				] as const
				for (const [code, reason] of cases) {
					const { outcome, seen } = yield* runProgram(code)
					assert.strictEqual(outcome._tag, "Failed", code)
					assert.strictEqual(
						outcome._tag === "Failed" && outcome.reason,
						reason,
						code,
					)
					assert.strictEqual(seen.length, 0, code)
				}
				const logged = yield* runProgram(
					"for (let i = 0; i < 1000; i++) console.log('line ' + i); return 1",
				)
				assert.strictEqual(logged.outcome._tag, "Done")
				if (logged.outcome._tag === "Done")
					assert.strictEqual(
						logged.outcome.logs.at(-1),
						"[More output was cut off.]",
					)
				// An App error reaches the program as an Error that it can catch.
				const denying = yield* makeSandbox
				const failing = yield* denying.run(
					{
						code: "try { await apps.calendar.list({}) } catch (error) { return [error.name, error.details.operationId] }",
						bindings: ["calendar.list"],
						seed: 1,
						clock: 1,
						limits,
					},
					(calls) =>
						Effect.succeedSome(
							Arr.map(calls, (call) => ({
								index: call.index,
								ok: false as const,
								error: JSON.stringify({
									name: "AppCallDenied",
									message: "No.",
									details: { operationId: "op_1" },
								}),
							})),
						),
				)
				assert.deepStrictEqual(failing._tag === "Done" && failing.value, [
					"AppCallDenied",
					"op_1",
				])
				// When the host gives no answer, the program stops and waits.
				const silent = yield* makeSandbox
				const stopped = yield* silent.run(
					{
						code: "await apps.calendar.list({}); return 1",
						bindings: ["calendar.list"],
						seed: 1,
						clock: 1,
						limits,
					},
					() => Effect.succeedNone,
				)
				assert.strictEqual(stopped._tag, "Stopped")
			}),
	)

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
					assert.strictEqual(receipt.delivery, "started")
					return yield* settled(asAlice, current)
				})
				const decide = Effect.fn("CodeMode.decide")(function* (
					decision: "allow" | "deny",
				) {
					const [request] = yield* pending
					assert.ok(request, "A call of the program waits for a decision.")
					const decided = yield* post("/v1/requests/" + request.id, {
						expected: request.revision,
						decision,
					})
					assert.strictEqual(decided.status, 200, yield* decided.text)
					return request
				})
				/** While a call waits, the Turn ends, and the Bot reads that the call is pending. */
				const paused = Effect.fn("CodeMode.paused")(function* (view: ChatView) {
					assert.strictEqual(view.status, "Completed")
					assert.strictEqual(view.open.requests, 1)
					assert.match(yield* jsonText(view.response), /pending/)
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

				// A program that makes other calls when it runs again stops, so no call goes out by mistake.
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
					(connection) => connection.name === "Work documents",
				)
				assert.ok(Option.isSome(workConnection), yield* jsonText(connections))
				const disabled = yield* call(
					alice.session,
					"/v1/connections/" + workConnection.value.id,
					"PUT",
					{
						revision: workConnection.value.revision,
						name: workConnection.value.name,
						enabled: false,
					},
				)
				assert.strictEqual(disabled.status, 200, yield* disabled.text)
				yield* decide("allow")
				yield* answered(/ReplayMismatch/)
				assert.strictEqual(yield* publisher.businessCalls, 5)
				assert.strictEqual((yield* publisher.writes).length, 1)

				// People read the programs of their Chats with the cookie or with a token.
				const chatId = yield* Ref.get(chat)
				const runs = yield* Effect.flatMap(
					read("/v1/chats/" + chatId + "/code-runs"),
					Caller.json(Schema.Array(CodeRunsApi.CodeRun)),
				)
				assert.deepStrictEqual(
					Arr.map(runs, (run) => [run.status, run.calls.length]),
					[
						["Completed", 2],
						["Completed", 1],
						["Completed", 2],
						["Failed", 2],
					],
				)
				const writtenRun = runs[2]
				assert.ok(writtenRun)
				assert.deepStrictEqual(
					Arr.map(writtenRun.calls, (entry) => entry.outcome._tag),
					["Done", "Done"],
				)
				assert.strictEqual(runs[1]?.calls[0]?.outcome._tag, "Denied")
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
					(yield* Caller.json(CodeRunsApi.CodeRun)(withToken)).id,
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
						Str.includes(":")(operation.callId),
					).length,
					7,
				)
				// The stored programs are sealed, like App operations.
				yield* host.run(
					Effect.gen(function* () {
						const sql = yield* PgClient.PgClient
						const rows = yield* sql<{
							readonly body: string
						}>`select body from openbot_code_runs`
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
				yield* host.run(
					Effect.gen(function* () {
						const settings = yield* Settings
						const current = yield* settings.platform
						if (Option.isNone(current)) return
						yield* settings.updatePlatform(current.value.version, (document) =>
							Effect.succeed({
								...document,
								codeMode: { ...document.codeMode!, enabled: false },
							}),
						)
					}),
				)
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
	)
})

it.effect(
	"each binding gets a stable short name and a TypeScript declaration",
	() =>
		Effect.sync(() => {
			const binding = (
				connectionId: string,
				connectionName: string,
				toolName: string,
				kind: "tool" | "resource" = "tool",
			): Binding => ({
				name: "openbot_" + toolName,
				source: {
					connectionId,
					connectionName,
					cardUrl: "https://apps.example.com/card",
					appName: "Example",
					remoteIndex: 0,
					revision: 0,
					kind,
					name: toolName,
				},
				schema: {
					type: "object",
					properties: {
						day: { type: "integer", description: "The day of the month." },
						tags: { type: "array", items: { type: "string" } },
						mode: { enum: ["fast", "slow"] },
					},
					required: ["day"],
				},
				description: "Lists events.",
				needsDecision: kind === "tool",
				readOnly: false,
				perform: () => Effect.die("unused"),
			})
			const named = name([
				binding("b", "Work calendar", "list-events"),
				binding("a", "Work calendar", "list-events"),
				binding("a", "Work calendar", "notes://index", "resource"),
				binding("c", "Call", "add"),
			])
			assert.deepStrictEqual(
				Arr.map(named, (entry) => entry.alias),
				[
					"work_calendar.notes_index_resource",
					"work_calendar.list_events",
					"work_calendar_2.list_events",
					"call_2.add",
				],
			)
			const text = declarations(named, ({ alias }) =>
				Str.startsWith("work_calendar.")(alias),
			)
			assert.match(text, /declare const apps: \{/)
			assert.match(
				text,
				/list_events\(args: \{ \/\*\* The day of the month\. \*\/ "day": number; "tags"\?: Array<string>; "mode"\?: "fast" \| "slow" \}\): Promise<ToolResult>/,
			)
			assert.match(
				text,
				/notes_index_resource\(args: .*\): Promise<ReadResult>/,
			)
			assert.strictEqual(Str.includes("work_calendar_2")(text), false)
		}),
)
