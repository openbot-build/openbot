import { assert, it } from "@effect/vitest"
import { Bot, Chat, Turn } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Option,
	Record as Rec,
	Ref,
	Schema,
	type Scope,
} from "effect"
import { Prompt, Tool } from "effect/ai"
import { Files } from "../src/apps-contract/files/Files.ts"
import type { Entry } from "../src/apps-contract/apps/WorkflowTools.ts"
import { Gate, Gates } from "../src/conversation-contract/capabilities/Gate.ts"
import type { Work } from "../src/conversation-contract/capabilities/Work.ts"
import * as BotFeatures from "../src/conversation-contract/chats/BotFeatures.ts"
import { TurnContext } from "../src/conversation-contract/chats/TurnContext.ts"
import * as ExecutionFeatures from "../src/plugin-chats/ExecutionFeatures.ts"
import { Records } from "@openbot-build/server-kernel/errors/Records"
import { Settings } from "@openbot-build/server-kernel/settings/Settings"
import type { Definition } from "../src/tools-contract/chats/ToolDefinitions.ts"
import * as BotFixture from "./BotFixture.ts"

const fence = {
	namespace: "test",
	id: Execution.Id.make("turn"),
	generation: 1,
}
const { chain, bot } = BotFixture.direct()
const identity = {
	owner: { organizationId: chain.organizationId, userId: chain.userId },
	actor: {
		kind: "member" as const,
		organizationId: chain.organizationId,
		userId: chain.userId,
	},
}
const frame = {
	identity,
	chat: Chat.Id.make("chat"),
	turn: Turn.Id.make("turn"),
}
const work: typeof Work.Service = {
	...frame,
	namespace: "test",
	bot,
	chain,
	deciders: [],
}
const definition: Definition = {
	name: "saved",
	parameters: {},
	readOnly: false,
	local: true,
	idempotent: false,
}

const gate = Gate.of({
	check: () => Effect.die("This test checks no capability."),
	remember: () => Effect.void,
	answer: () => Effect.succeedNone,
})

const registration = (
	names: ReadonlyArray<string>,
): Bot.ToolRegistration<{}, never, never> => ({
	tools: Rec.fromEntries(
		Arr.map(names, (name) => [name, Tool.make(name)] as const),
	),
	handlers: Context.empty(),
})

const entry = (name: string): Entry => ({
	tool: Tool.make(name),
	handle: () => Effect.succeed(null),
})

/** A fake feature that records each build with the Gate that it got. */
const feature = (
	built: Ref.Ref<ReadonlyArray<string>>,
	id: string,
	options: {
		readonly order: number
		readonly version?: number
		readonly review?: boolean
		readonly restores?: ReadonlyArray<string>
		readonly restore?: Option.Option<Entry>
	},
): BotFeatures.Contribution => ({
	id,
	version: options.version ?? 1,
	order: options.order,
	build: "normal",
	review: options.review ?? true,
	restores: options.restores ?? [],
	settings: Effect.succeed(null),
	prepare: (prepared) =>
		Effect.gen(function* () {
			const given = yield* Gate
			assert.strictEqual(given, gate)
			yield* Ref.update(built, Arr.append(`${id}:${prepared.id}`))
			return {
				register: () => Effect.succeed(registration([`${id}_tool`])),
				restoreTool: (_, name) => Effect.succeed(registration([name])),
			}
		}),
	...(options.restore === undefined
		? {}
		: { restore: () => options.restore ?? Option.none() }),
})

const run = <A, E>(
	test: (
		features: typeof BotFeatures.BotFeatures.Service,
		execution: ExecutionFeatures.Service,
		gates: Ref.Ref<number>,
	) => Effect.Effect<A, E, Scope.Scope>,
) =>
	Effect.gen(function* () {
		const gates = yield* Ref.make(0)
		const layer = ExecutionFeatures.layer.pipe(
			Layer.provide(
				Layer.mergeAll(
					Layer.succeed(
						Gates,
						Gates.of({
							durable: () =>
								Effect.as(
									Ref.update(gates, (n) => n + 1),
									gate,
								),
						}),
					),
					Layer.mock(Files, {}),
					Layer.mock(Settings, {}),
					Layer.mock(TurnContext, {}),
					Layer.mock(Records, {}),
				),
			),
			Layer.provideMerge(BotFeatures.layer),
		)
		return yield* Effect.gen(function* () {
			const features = yield* BotFeatures.BotFeatures
			const execution = yield* ExecutionFeatures.ExecutionFeatures
			return yield* test(features, execution, gates)
		}).pipe(Effect.provide(layer))
	}).pipe(Effect.scoped)

/** The tools here do not read the Chat. */
const context = Bot.Context.of({
	options: { prompt: Prompt.empty },
	at: Effect.die("This test reads no Chat."),
	turn: Effect.succeed(frame.turn),
	step: Effect.succeed(0),
	history: Effect.succeed(Prompt.empty),
})
const host = Effect.succeed(registration(["host_tool", "claimed"]))
const notify: BotFeatures.Notify = () => Effect.void

it.effect(
	"open builds each held feature once for its fence, in order, with one Gate",
	() =>
		run((features, execution, gates) =>
			Effect.gen(function* () {
				const built = yield* Ref.make<ReadonlyArray<string>>([])
				yield* features.contribute(feature(built, "second", { order: 20 }))
				yield* features.contribute(feature(built, "first", { order: 10 }))
				yield* execution.open(fence, frame, yield* features.snapshot)
				assert.deepStrictEqual(yield* Ref.get(built), [
					"first:turn",
					"second:turn",
				])
				assert.equal(yield* Ref.get(gates), 1)
			}),
		),
)

it.effect(
	"open fails with ExecutionConflict when a pinned version changed",
	() =>
		run((features, execution, gates) =>
			Effect.gen(function* () {
				const built = yield* Ref.make<ReadonlyArray<string>>([])
				yield* features.contribute(
					feature(built, "tools", { order: 10, version: 2 }),
				)
				const failure = yield* execution
					.open(fence, frame, [{ id: "tools", version: 1, settings: null }])
					.pipe(Effect.flip)
				assert.ok(Schema.is(Execution.Conflict)(failure))
				assert.deepStrictEqual(yield* Ref.get(built), [])
				assert.equal(yield* Ref.get(gates), 0)
			}),
		),
)

const toolNames = (value: Bot.ToolRegistration) => {
	const tools: Readonly<Record<string, Tool.Any>> = value.tools
	return Rec.keys(tools)
}

it.effect(
	"restoreTool gives back a claimed name through its feature, and other names through the host",
	() =>
		run((features, execution) =>
			Effect.gen(function* () {
				const built = yield* Ref.make<ReadonlyArray<string>>([])
				yield* features.contribute(
					feature(built, "computers", {
						order: 60,
						review: false,
						restores: ["claimed"],
					}),
				)
				const policy = { review: false, plan: false }
				const claimed = yield* execution.restoreTool(fence, work, {
					name: "claimed",
					notify,
					host,
					policy,
				})
				assert.deepStrictEqual(toolNames(claimed), ["claimed"])
				assert.deepStrictEqual(yield* Ref.get(built), ["computers:turn"])
				const other = yield* execution.restoreTool(fence, work, {
					name: "host_tool",
					notify,
					host,
					policy,
				})
				assert.deepStrictEqual(toolNames(other), ["host_tool"])
				assert.deepStrictEqual(yield* Ref.get(built), ["computers:turn"])
			}).pipe(Effect.provideService(Bot.Context, context)),
		),
)

it.effect(
	"restoreTool in a review Chat does not use a feature that is not for review",
	() =>
		run((features, execution) =>
			Effect.gen(function* () {
				const built = yield* Ref.make<ReadonlyArray<string>>([])
				yield* features.contribute(
					feature(built, "computers", {
						order: 60,
						review: false,
						restores: ["claimed"],
					}),
				)
				yield* execution.restoreTool(fence, work, {
					name: "claimed",
					notify,
					host,
					policy: { review: true, plan: false },
				})
				assert.deepStrictEqual(yield* Ref.get(built), [])
			}).pipe(Effect.provideService(Bot.Context, context)),
		),
)

it.effect("restore asks the features in order and takes the first entry", () =>
	run((features, execution) =>
		Effect.gen(function* () {
			const built = yield* Ref.make<ReadonlyArray<string>>([])
			yield* features.contribute(
				feature(built, "later", {
					order: 20,
					restore: Option.some(entry("later")),
				}),
			)
			yield* features.contribute(
				feature(built, "empty", { order: 5, restore: Option.none() }),
			)
			yield* features.contribute(
				feature(built, "apps", {
					order: 10,
					restore: Option.some(entry("apps")),
				}),
			)
			const restored = yield* execution.restore(fence, definition)
			assert.deepStrictEqual(
				Option.map(restored, (value) => value.tool.name),
				Option.some("apps"),
			)
		}),
	),
)

it.effect(
	"restore in a Turn uses the held features, not the present ones",
	() =>
		run((features, execution) =>
			Effect.gen(function* () {
				const built = yield* Ref.make<ReadonlyArray<string>>([])
				yield* features.contribute(
					feature(built, "held", { order: 20, restore: Option.none() }),
				)
				const chat = yield* execution.open(
					fence,
					frame,
					yield* features.snapshot,
				)
				yield* features.contribute(
					feature(built, "new", {
						order: 10,
						restore: Option.some(entry("new")),
					}),
				)
				assert.ok(Option.isNone(chat.restore(definition)))
				assert.ok(Option.isSome(yield* execution.restore(fence, definition)))
			}),
		),
)
