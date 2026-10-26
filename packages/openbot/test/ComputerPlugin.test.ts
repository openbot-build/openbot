import { assert, describe, it } from "@effect/vitest"
import { ComputersApi } from "@openbot-build/api"
import { Bot, Chat, Turn } from "@openbot-build/core"
import {
	Array as Arr,
	Effect,
	HashMap,
	Layer,
	Option,
	Predicate,
	Record as Rec,
	Ref,
	Stream,
} from "effect"
import { Prompt, Tool, Toolkit } from "effect/ai"
import * as Approvals from "../src/capabilities/Approvals.ts"
import { Answer, Gate } from "../src/capabilities/Gate.ts"
import { Requests } from "../src/capabilities/Requests.ts"
import { Work } from "../src/capabilities/Work.ts"
import type { Machine } from "../src/computers/Computer.ts"
import { ComputerProviders } from "../src/computers/ComputerProviders.ts"
import { Computers } from "../src/computers/Computers.ts"
import { Sessions } from "../src/computers/Sessions.ts"
import * as ComputerPlugin from "../src/plugins/computers/ComputerPlugin.ts"
import { bot } from "./BotFixture.ts"

const { names } = ComputerPlugin

/** What the fakes saw. */
interface Seen {
	/** The actions that went to the Gate. */
	readonly checks: Ref.Ref<ReadonlyArray<string>>
	/** The requests that went to `Sessions.exec`. */
	readonly runs: Ref.Ref<ReadonlyArray<ComputersApi.ExecRequest>>
}

interface Fakes {
	readonly computers?: Partial<Computers["Service"]>
	readonly providers?: Partial<ComputerProviders["Service"]>
}

/**
 * The Computer plugin and Approvals with fakes. A fake has only the methods that a
 * test may call. The Gate allows every check, so only a remembered Deny can stop a call.
 */
const pluginWith = (seen: Seen, fakes: Fakes) =>
	Layer.merge(
		ComputerPlugin.layer,
		Approvals.layer.pipe(
			Layer.provide(Layer.succeed(Requests, {} as Requests["Service"])),
		),
	).pipe(
		Layer.provide([
			Layer.succeed(Gate, {
				...({} as Gate["Service"]),
				check: (attempt) =>
					Ref.update(seen.checks, Arr.append(attempt.capability.action)).pipe(
						Effect.as(Answer.Allow()),
					),
			}),
			Layer.succeed(Computers, {
				...({} as Computers["Service"]),
				heldBy: () => Effect.succeed([]),
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
const makeWork = Effect.map(
	Ref.make(HashMap.empty<string, Answer>()),
	(checks) =>
		Work.of({
			caller: { kind: "member", organizationId: "org_1", userId: "user_1" },
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
			checks,
		}),
)

/**
 * Runs `use` in a Turn of the test Bot, with the tools of the plugin and their
 * handlers. The plugin reads no Bot context, so an empty one is enough.
 */
const inTurn = <A, E>(
	work: Work["Service"],
	use: (
		toolkit: Toolkit.WithHandler<ComputerPlugin.Tools>,
	) => Effect.Effect<A, E, Work | Chat.Approvals>,
) =>
	Effect.gen(function* () {
		const plugin = (yield* ComputerPlugin.ComputerPlugin).forOwner({
			notify: () => Effect.void,
		})
		const middleware = yield* plugin.middleware
		const out = yield* Ref.make(Option.none<A>())
		yield* middleware<never, never, E, Work | Chat.Approvals>(
			(options) =>
				Stream.fromEffect(
					options.toolkit.pipe(
						// The plugin gives the handlers of its tools to the rest of the Turn,
						// so the toolkit finds them there. Its type cannot say so.
						Effect.flatMap(
							(toolkit) =>
								toolkit as unknown as Effect.Effect<
									Toolkit.WithHandler<ComputerPlugin.Tools>
								>,
						),
						Effect.flatMap(use),
						Effect.flatMap((value) => Ref.set(out, Option.some(value))),
					),
				).pipe(Stream.drain),
			{
				prompt: [],
				instructions: Prompt.empty,
				toolkit: Effect.succeed(Toolkit.empty),
			},
		).pipe(
			Stream.runDrain,
			Effect.provideService(Work, work),
			Effect.provideService(Bot.Context, {} as Bot.Context["Service"]),
		)
		return yield* Effect.flatMap(Ref.get(out), Effect.fromOption)
	}).pipe(Effect.scoped)

/** Runs a test with the plugin, its fakes and a Turn of the test Bot. */
const withPlugin = <A, E>(
	fakes: Fakes,
	test: (input: {
		readonly seen: Seen
		readonly work: Work["Service"]
		readonly toolkit: Toolkit.WithHandler<ComputerPlugin.Tools>
	}) => Effect.Effect<A, E, Work | Chat.Approvals>,
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
	toolkit: Toolkit.WithHandler<ComputerPlugin.Tools>,
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
	toolkit: Toolkit.WithHandler<ComputerPlugin.Tools>,
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
						"session",
						"chars",
						"yield_time_ms",
						"max_output_bytes",
						"rows",
						"cols",
					])
					assert.deepStrictEqual(write.schema["required"], ["session", "chars"])
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
								machine: {} as Machine,
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
				({ seen, work, toolkit }) =>
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
							Chat.Decision.Deny({ reason: "ComputerNotFound" }),
						)
						assert.deepStrictEqual(yield* Ref.get(seen.checks), [])
						assert.isTrue(HashMap.has(yield* Ref.get(work.checks), "call_1"))
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
										Chat.Decision.Deny({ reason: "ComputersUnavailable" }),
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
		"a Bot reads why it may not open a port of a Computer that it does not hold",
		() =>
			withPlugin(
				{ computers: { holds: () => Effect.succeed(false) } },
				({ toolkit }) =>
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
								reason: `You may not use the Computer cmp_1. Get it first with ${names.acquire}.`,
							}),
						)
					}),
			),
	)

	it.effect("a wrong call does not wait for a decision", () =>
		withPlugin({}, ({ seen, work, toolkit }) =>
			Effect.gen(function* () {
				const tool = toolkit.tools[names.acquire]
				assert.ok(tool !== undefined)
				assert.isFalse(yield* needsApproval(tool, { reason: 1 }, "call_1"))
				assert.isTrue(HashMap.isEmpty(yield* Ref.get(work.checks)))
				assert.deepStrictEqual(yield* Ref.get(seen.checks), [])
			}),
		),
	)
})
