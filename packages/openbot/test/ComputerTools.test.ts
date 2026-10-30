import {
	Files as FileData,
	Authorization,
	Execution,
	TokenId,
	restrictExecution,
} from "@openbot-build/domain"
import { assert, describe, it } from "@effect/vitest"
import { ComputersApi } from "@openbot-build/api"
import { Chat, Turn } from "@openbot-build/core"
import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Predicate,
	Option,
	Record as Rec,
	Ref,
	Schema,
	Stream,
} from "effect"
import { Prompt, Tool, Toolkit } from "effect/ai"
import * as ToolApprovals from "./ToolApprovals.ts"
import { Answer, Gate } from "../src/capabilities/Gate.ts"
import { Work } from "../src/capabilities/Work.ts"
import type { Machine } from "../src/computers/Computer.ts"
import { ComputerProviders } from "../src/computers/ComputerProviders.ts"
import { Computers } from "../src/computers/Computers.ts"
import { Sessions } from "../src/computers/Sessions.ts"
import { Idempotent, SavedResult } from "../src/plugins/ToolEntry.ts"
import * as ComputerTools from "../src/plugins/computers/ComputerTools.ts"
import { bot } from "./BotFixture.ts"
import { Authorizer, Policy } from "@nmnmcc/ability"
import { CallContext } from "../src/execution/CallContext.ts"
import { Files } from "../src/files/Files.ts"
import { Records } from "../src/errors/Records.ts"

const { names } = ComputerTools

/** What the fakes saw. */
interface Seen {
	/** The actions that went to the Gate. */
	readonly checks: Ref.Ref<ReadonlyArray<string>>
	/** The requests that went to `Sessions.exec`. */
	readonly runs: Ref.Ref<ReadonlyArray<ComputersApi.ExecRequest>>
}

interface Fakes {
	readonly fileWrites?: boolean
	readonly files?: Partial<Files["Service"]>
	readonly computers?: Partial<Computers["Service"]>
	readonly providers?: Partial<ComputerProviders["Service"]>
}

/**
 * The Computer plugin and Approvals with fakes. A fake has only the methods that a
 * test may call. The Gate allows every check, so only a remembered Deny can stop a call.
 */
const pluginWith = (seen: Seen, fakes: Fakes) =>
	ComputerTools.layer.pipe(
		Layer.provideMerge(
			ToolApprovals.layer((attempt) =>
				Ref.update(seen.checks, Arr.append(attempt.capability.action)).pipe(
					Effect.as(Answer.Allow()),
				),
			),
		),
		Layer.provide([
			Authorizer.layer(Authorization.Auth, {
				policy: () =>
					Effect.succeed(
						Policy.define(Authorization.OpenBot)(function* (_) {
							if (fakes.fileWrites === false) yield* _.allow("read", "File")
							else yield* _.allow("*", "*")
						}),
					),
			}),
			Layer.mock(Files, fakes.files ?? {}),
			Layer.mock(Records, {
				record: (_cause, category) =>
					Effect.succeed({
						errorId: Execution.ErrorId.make("test-error"),
						category,
					}),
			}),
			Layer.succeed(Computers, {
				...({} as Computers["Service"]),
				list: () => Effect.succeed([]),
				...fakes.computers,
			}),
			Layer.succeed(Sessions, {
				...({} as Sessions["Service"]),
				exec: (input) =>
					Ref.update(seen.runs, Arr.append(input.request)).pipe(
						Effect.as({
							session: null,
							running: false,
							exitCode: 0,
							signal: null,
							output: "",
							truncated: false,
						}),
					),
			}),
			Layer.succeed(ComputerProviders, {
				...({} as ComputerProviders["Service"]),
				...fakes.providers,
			}),
		]),
	)

/** The Work of the test Bot in a Chat of its member. */
const makeWork = Effect.succeed(
	Work.of({
		identity: {
			owner: { organizationId: "org_1", userId: "user_1" },
			actor: { kind: "member", organizationId: "org_1", userId: "user_1" },
			botId: bot.id,
		},
		namespace: "org_1:user_1",
		bot,
		chain: {
			organizationId: "org_1",
			userId: "user_1",
			bots: [bot.id],
			chats: [],
		},
		deciders: [bot.id],
		chat: Chat.Id.make("chat_1"),
		turn: Turn.Id.make("turn_1"),
	}),
)

/**
 * Runs `use` in a Turn of the test Bot, with the tools of the plugin and their
 * handlers. The plugin reads no Bot context, so an empty one is enough.
 */
const inTurn = <A, E>(
	work: Work["Service"],
	use: (
		toolkit: Toolkit.WithHandler<ComputerTools.Tools>,
	) => Effect.Effect<A, E, Work | Chat.Approvals | Gate | CallContext>,
) =>
	Effect.gen(function* () {
		const registration = yield* (yield* ComputerTools.ComputerTools).register({
			notify: () => Effect.void,
		})
		const toolkit = Toolkit.make(...Rec.values(registration.tools))
		return yield* Effect.flatMap(toolkit, use).pipe(
			Effect.provideContext(registration.handlers),
		)
	}).pipe(
		Effect.provideService(Work, work),
		Effect.provideService(CallContext, {
			id: Execution.CallId.make("export-call"),
			fence: {
				namespace: work.namespace,
				id: Execution.Id.make("execution_1"),
				generation: 1,
			},
		}),
		Effect.scoped,
	)

/** Runs a test with the plugin, its fakes and a Turn of the test Bot. */
const withPlugin = <A, E>(
	fakes: Fakes,
	test: (input: {
		readonly seen: Seen
		readonly work: Work["Service"]
		readonly toolkit: Toolkit.WithHandler<ComputerTools.Tools>
	}) => Effect.Effect<A, E, Work | Chat.Approvals | Gate | CallContext>,
) =>
	Effect.gen(function* () {
		const seen = yield* Effect.all({
			checks: Ref.make<ReadonlyArray<string>>([]),
			runs: Ref.make<ReadonlyArray<ComputersApi.ExecRequest>>([]),
		})
		const work = yield* makeWork
		return yield* inTurn(work, (toolkit) => test({ seen, work, toolkit })).pipe(
			Effect.provide(pluginWith(seen, fakes)),
		)
	})

/** Asks whether a call of the tool needs a decision, as the runtime does. */
const needsApproval = (tool: Tool.Any, params: unknown, toolCallId: string) => {
	const check = tool.needsApproval
	if (!Predicate.isFunction(check)) return Effect.succeed(check === true)
	const result = check(params, { toolCallId, messages: [] })
	return Effect.isEffect(result) ? result : Effect.succeed(result)
}

/**
 * Asks whether a call needs a decision, and then lets Approvals decide it, as the
 * runtime does before it runs the handler.
 */
const decide = (
	toolkit: Toolkit.WithHandler<ComputerTools.Tools>,
	name: string,
	params: Record<string, unknown>,
	toolCallId: string,
) =>
	Effect.gen(function* () {
		const tool = toolkit.tools[name]
		if (tool === undefined) return yield* Effect.die("There is no tool " + name)
		const asks = yield* needsApproval(tool, params, toolCallId)
		const decision = yield* (yield* Chat.Approvals).decide({
			chat: Chat.Id.make("chat_1"),
			turn: Turn.Id.make("turn_1"),
			approvalId: "approval_" + toolCallId,
			toolCall: Prompt.toolCallPart({
				id: toolCallId,
				name,
				params,
				providerExecuted: false,
			}),
		})
		return { asks, decision }
	})

/** The JSON Schema that the model sees for a tool, with its properties. */
const schemaOf = (
	toolkit: Toolkit.WithHandler<ComputerTools.Tools>,
	name: string,
) => {
	const tool = toolkit.tools[name]
	const schema: Record<string, unknown> =
		tool === undefined ? {} : Tool.getJsonSchema(tool)
	return {
		schema,
		properties: (schema["properties"] ?? {}) as Record<
			string,
			Record<string, unknown>
		>,
	}
}

const unavailable = () =>
	Effect.fail(ComputersApi.ComputersUnavailable.make({}))

describe("Computer tools", () => {
	it.effect(
		"export requires the caller's File write right before reading its source",
		() =>
			withPlugin(
				{
					fileWrites: false,
					files: {
						saved: () =>
							Effect.die("A denied export must not read file records"),
						save: () => Effect.die("A denied export must not upload"),
					},
					computers: {
						holds: () => Effect.succeed(true),
						machine: () =>
							Effect.die("A denied export must not read the Computer"),
					},
				},
				({ toolkit }) =>
					Effect.gen(function* () {
						const output = yield* toolkit
							.handle(
								names.export,
								{
									computer: "cmp_1",
									path: "/workspace/result",
									name: "result.txt",
									mediaType: "text/plain",
								},
								"export-denied",
							)
							.pipe(Effect.flatMap(Stream.runCollect))
						assert.include(
							yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
								output,
							),
							'"error"',
						)
					}),
			),
	)

	it.effect(
		"exports bytes to Files once and recovers metadata without reading a recycled Computer",
		() =>
			Effect.gen(function* () {
				const file: FileData.FileObject = {
					id: FileData.FileId.make("file_output"),
					object: "file",
					filename: "slides.pptx",
					mediaType:
						"application/vnd.openxmlformats-officedocument.presentationml.presentation",
					bytes: 5,
					status: "ready",
					createdAt: 1,
				}
				let saved: Option.Option<FileData.FileObject> = Option.none()
				let reads = 0
				let writes = 0
				yield* withPlugin(
					{
						files: {
							saved: () => Effect.succeed(saved),
							save: (owner, input) =>
								Effect.sync(() => {
									writes++
									assert.deepStrictEqual(owner, {
										kind: "member",
										organizationId: "org_1",
										userId: "user_1",
									})
									assert.strictEqual(input.key, "export-call")
									assert.deepStrictEqual(input.reference, {
										namespace: "org_1:user_1",
										chat: "chat_1",
									})
									assert.deepStrictEqual(
										[...input.content.bytes],
										[0, 1, 2, 3, 4],
									)
									saved = Option.some(file)
									return file
								}),
						},
						computers: {
							holds: () => Effect.succeed(true),
							work: Effect.orDie,
							machine: () =>
								Effect.succeed({
									computer: {} as ComputersApi.Computer,
									machine: {
										...({} as Machine),
										shell: {
											read: (path: string, encoding: string) =>
												Effect.sync(() => {
													reads++
													assert.strictEqual(encoding, "base64")
													return {
														path,
														encoding: "base64" as const,
														content: "AAECAwQ=",
													}
												}),
										},
									} as unknown as Machine,
								}),
						},
					},
					({ toolkit }) =>
						Effect.gen(function* () {
							const input = {
								computer: "cmp_1",
								path: "/workspace/slides.pptx",
								name: file.filename,
								mediaType: file.mediaType,
							}
							const first = yield* toolkit
								.handle(names.export, input, "tool-export")
								.pipe(Effect.flatMap(Stream.runCollect))
							const second = yield* toolkit
								.handle(names.export, input, "tool-export")
								.pipe(Effect.flatMap(Stream.runCollect))
							assert.deepStrictEqual(first, second)
							assert.include(
								yield* Schema.encodeEffect(
									Schema.fromJsonString(Schema.Unknown),
								)(first),
								"openbot-file:file_output",
							)
							assert.notInclude(
								yield* Schema.encodeEffect(
									Schema.fromJsonString(Schema.Unknown),
								)(first),
								"AAECAwQ=",
							)
							assert.strictEqual(reads, 1)
							assert.strictEqual(writes, 1)
							assert.strictEqual(
								Context.get(
									toolkit.tools[names.export]!.annotations,
									Idempotent,
								),
								true,
							)
							const recover = Context.get(
								toolkit.tools[names.export]!.annotations,
								SavedResult,
							)
							assert.ok(recover)
							assert.deepStrictEqual(
								yield* recover(Execution.CallId.make("export-call"), input),
								Option.some({ file, uri: "openbot-file:file_output" }),
							)
							assert.strictEqual(reads, 1)
						}),
				)
			}),
	)
	it.effect(
		"a failed export reports an error and does not advertise a saved attachment",
		() =>
			withPlugin(
				{
					files: {
						saved: () => Effect.succeedNone,
						save: () =>
							Effect.fail(
								FileData.FileQuotaExceeded.make({
									message: "Full",
									quotaBytes: 1,
									usedBytes: 1,
								}),
							),
					},
					computers: {
						holds: () => Effect.succeed(true),
						work: Effect.orDie,
						machine: () =>
							Effect.succeed({
								computer: {} as ComputersApi.Computer,
								machine: {
									shell: {
										read: (path: string) =>
											Effect.succeed({
												path,
												encoding: "base64" as const,
												content: "AAECAwQ=",
											}),
									},
								} as unknown as Machine,
							}),
					},
				},
				({ toolkit }) =>
					Effect.gen(function* () {
						const output = yield* toolkit
							.handle(
								names.export,
								{
									computer: "cmp_1",
									path: "/workspace/result",
									name: "result.txt",
									mediaType: "text/plain",
								},
								"export-error",
							)
							.pipe(Effect.flatMap(Stream.runCollect))
						assert.include(
							yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
								output,
							),
							'"error"',
						)
						assert.notInclude(
							yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
								output,
							),
							"openbot-file:",
						)
					}),
			),
	)

	it.effect(
		"held Computer tools check the task input token before using a machine or session",
		() =>
			Effect.gen(function* () {
				const work = yield* makeWork
				const caller = {
					...work.identity.actor,
					kind: "user_token" as const,
					tokenId: TokenId.make("narrow"),
				}
				const checked = yield* Ref.make<ReadonlyArray<string>>([])
				const seen = yield* Effect.all({
					checks: Ref.make<ReadonlyArray<string>>([]),
					runs: Ref.make<ReadonlyArray<ComputersApi.ExecRequest>>([]),
				})
				const fakes: Fakes = {
					computers: {
						holds: () => Effect.succeed(true),
						get: (who, id, need) =>
							Ref.update(
								checked,
								Arr.append(`${who.tokenId}:${id}:${need}`),
							).pipe(
								Effect.andThen(
									Effect.fail(ComputersApi.ComputerNotFound.make({ id })),
								),
							),
						machine: () =>
							Effect.die("A denied token must not open the Computer."),
					},
				}
				for (const name of [names.screenshot, names.writeStdin, names.export]) {
					yield* inTurn(
						{ ...work, identity: restrictExecution(work.identity, [caller]) },
						(toolkit) =>
							toolkit
								.handle(
									name,
									{
										computer: "computer",
										path: "/workspace/file.txt",
										name: "file.txt",
										mediaType: "text/plain",
										session: "cse_one",
										chars: "run\n",
										rows: 24,
										cols: 80,
									},
									name,
								)
								.pipe(Effect.flatMap(Stream.runDrain)),
					).pipe(Effect.provide(pluginWith(seen, fakes)))
				}
				assert.deepStrictEqual(yield* Ref.get(checked), [
					"narrow:computer:use",
					"narrow:computer:use",
					"narrow:computer:use",
				])
			}),
	)

	it.effect(
		"each tool shows the model the keys, limits and texts of its input Schema",
		() =>
			withPlugin({}, ({ toolkit }) =>
				Effect.sync(() => {
					for (const name of Rec.values(names))
						assert.strictEqual(schemaOf(toolkit, name).schema["type"], "object")
					const exec = schemaOf(toolkit, names.exec)
					assert.deepStrictEqual(Rec.keys(exec.properties), [
						"computer",
						"command",
						"cwd",
						"env",
						"tty",
						"rows",
						"cols",
						"yield_time_ms",
						"max_output_bytes",
					])
					assert.deepStrictEqual(exec.schema["required"], [
						"computer",
						"command",
					])
					assert.strictEqual(
						exec.properties["computer"]?.["description"],
						`The ID of the Computer, from ${names.list}.`,
					)
					assert.strictEqual(
						exec.properties["command"]?.["description"],
						"It runs with bash -lc.",
					)
					assert.strictEqual(exec.properties["command"]?.["minLength"], 1)
					assert.strictEqual(exec.properties["yield_time_ms"]?.["minimum"], 250)
					assert.strictEqual(
						exec.properties["yield_time_ms"]?.["maximum"],
						30000,
					)
					assert.strictEqual(
						exec.properties["max_output_bytes"]?.["description"],
						"The most output to give back. The default is 65536.",
					)
					const write = schemaOf(toolkit, names.writeStdin)
					assert.deepStrictEqual(Rec.keys(write.properties), [
						"computer",
						"session",
						"chars",
						"yield_time_ms",
						"max_output_bytes",
						"rows",
						"cols",
					])
					assert.deepStrictEqual(write.schema["required"], [
						"computer",
						"session",
						"chars",
					])
					const create = schemaOf(toolkit, names.create)
					assert.deepStrictEqual(create.schema["required"], ["name", "source"])
					const source = (create.properties["source"]?.["properties"] ??
						{}) as Record<string, Record<string, unknown>>
					assert.strictEqual(
						source["provider"]?.["description"],
						`The ID of a Computer provider, from ${names.list}.`,
					)
					assert.strictEqual(
						create.properties["reason"]?.["description"],
						"Why you need it, in one short sentence.",
					)
					assert.ok(
						Predicate.isString(
							create.properties["pauseAfter"]?.["description"],
						),
						"pauseAfter has a description",
					)
					const desktop = schemaOf(toolkit, names.desktop)
					assert.strictEqual(desktop.properties["actions"]?.["minItems"], 1)
					assert.strictEqual(desktop.properties["actions"]?.["maxItems"], 50)
					assert.ok(
						Predicate.isString(desktop.properties["actions"]?.["description"]),
						"the actions have an example",
					)
					assert.deepStrictEqual(
						schemaOf(toolkit, names.read).properties["encoding"]?.["enum"],
						["utf8", "base64"],
					)
					assert.strictEqual(
						schemaOf(toolkit, names.port).properties["port"]?.["maximum"],
						65535,
					)
				}),
			),
	)

	it.effect(
		"a command gets the snake_case keys of the model as API fields",
		() =>
			withPlugin(
				{
					computers: {
						holds: () => Effect.succeed(true),
						machine: () =>
							Effect.succeed({
								computer: {} as ComputersApi.Computer,
								machine: {} as unknown as Machine,
							}),
						work: Effect.orDie,
					},
				},
				({ seen, toolkit }) =>
					Effect.gen(function* () {
						const results = yield* toolkit.handle(
							names.exec,
							{
								computer: "cmp_1",
								command: "ls",
								yield_time_ms: 500,
								max_output_bytes: 100,
							},
							"call_1",
						)
						yield* Stream.runDrain(results)
						assert.deepStrictEqual(yield* Ref.get(seen.runs), [
							{ command: "ls", yieldTimeMs: 500, maxOutputBytes: 100 },
						])
					}),
			),
	)

	it.effect(
		"a Bot cannot get the right to use a Computer that its person may not read",
		() =>
			withPlugin(
				{
					computers: {
						holds: () => Effect.succeed(false),
						get: (_caller, id) =>
							Effect.fail(ComputersApi.ComputerNotFound.make({ id })),
					},
				},
				({ seen, toolkit }) =>
					Effect.gen(function* () {
						const { asks, decision } = yield* decide(
							toolkit,
							names.acquire,
							{ computer: "cmp_private", reason: "I need it." },
							"call_1",
						)
						assert.isTrue(asks)
						// The handler runs only after an Allow, so no right is given.
						assert.deepStrictEqual(
							decision,
							Chat.Decision.Deny({ reason: "unavailable (test-error)" }),
						)
						assert.deepStrictEqual(yield* Ref.get(seen.checks), [])
						assert.isTrue(Option.isSome(yield* (yield* Gate).answer("call_1")))
					}),
			),
	)

	it.effect(
		"a Computer action whose check cannot read the store never runs",
		() =>
			withPlugin(
				{
					computers: { holds: unavailable, get: unavailable },
					providers: { get: unavailable },
				},
				({ seen, toolkit }) =>
					Effect.gen(function* () {
						const calls = [
							[names.acquire, { computer: "cmp_1" }],
							[names.release, { computer: "cmp_1", destroy: true }],
							[
								names.create,
								{
									name: "Box",
									source: {
										_tag: "Provider",
										provider: "cpr_1",
										template: null,
									},
								},
							],
							[names.port, { computer: "cmp_1", port: 3000 }],
						] as const
						yield* Effect.forEach(calls, ([name, params], index) =>
							Effect.map(
								decide(toolkit, name, params, "call_" + index),
								({ asks, decision }) => {
									assert.isTrue(asks, name)
									assert.deepStrictEqual(
										decision,
										Chat.Decision.Deny({ reason: "unavailable (test-error)" }),
										name,
									)
								},
							),
						)
						// No generic check got the chance to allow a call.
						assert.deepStrictEqual(yield* Ref.get(seen.checks), [])
					}),
			),
	)

	it.effect(
		"a Bot gets a safe error when it may not open a Computer port",
		() =>
			withPlugin(
				{ computers: { holds: () => Effect.succeed(false) } },
				({ seen, toolkit }) =>
					Effect.gen(function* () {
						const { asks, decision } = yield* decide(
							toolkit,
							names.port,
							{ computer: "cmp_1", port: 3000 },
							"call_1",
						)
						assert.isTrue(asks)
						assert.deepStrictEqual(
							decision,
							Chat.Decision.Deny({
								reason: "forbidden (test-error)",
							}),
						)
						assert.deepStrictEqual(yield* Ref.get(seen.checks), [])
						assert.deepStrictEqual(yield* Ref.get(seen.runs), [])
					}),
			),
	)

	it.effect("a wrong call does not wait for a decision", () =>
		withPlugin({}, ({ seen, toolkit }) =>
			Effect.gen(function* () {
				const tool = toolkit.tools[names.acquire]
				assert.ok(tool !== undefined)
				assert.isFalse(yield* needsApproval(tool, { reason: 1 }, "call_1"))
				assert.isTrue(Option.isNone(yield* (yield* Gate).answer("call_1")))
				assert.deepStrictEqual(yield* Ref.get(seen.checks), [])
			}),
		),
	)
})
