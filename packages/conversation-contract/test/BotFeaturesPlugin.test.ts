import { assert, it } from "@effect/vitest"
import { Chat, Plugin, Turn } from "@openbot-build/core"
import { Context, Duration, Effect, Schema } from "effect"
import { Prompt } from "effect/ai"
import {
	FeatureStopped,
	fromPlugin,
} from "@openbot-build/conversation-contract/chats/BotFeatures"

class Stop extends Schema.TaggedError<
	Stop,
	{ readonly brand: unique symbol }
>()("TestStop", { step: Schema.Int }) {}

const turn: Turn.Record = {
	id: Turn.Id.make("turn"),
	chat: Chat.Id.make("chat"),
	settings: { mode: "build" },
	status: { _tag: "Running" },
	steps: 0,
	input: [],
	items: [],
	startedAt: 0,
}
const step = (n: number): Plugin.StepInput => ({
	turn,
	kind: "model",
	step: n,
	history: Prompt.empty,
})

const handlers = Context.empty()
const instructions = Prompt.make("Keep it short.")

const limited = Plugin.make({ id: Plugin.Id.make("limited") })<{}, Stop>(() =>
	Effect.succeed({
		tools: {},
		handlers,
		instructions,
		beforeStep: ({ step }) =>
			step > 1 ? Effect.fail(Stop.make({ step })) : Effect.succeed(true),
		afterStep: ({ step }) => Effect.fail(Stop.make({ step })),
		timeLimit: {
			duration: Duration.seconds(5),
			error: () => Stop.make({ step: 0 }),
		},
	}),
)

it.effect(
	"a Bot plugin as a feature keeps its tools, handlers and instructions",
	() =>
		Effect.gen(function* () {
			const registration = yield* fromPlugin("limited", limited).register()
			assert.deepStrictEqual(registration.tools, {})
			assert.strictEqual(registration.handlers, handlers)
			assert.strictEqual(registration.instructions, instructions)
		}).pipe(Effect.scoped),
)

it.effect(
	"a failure of a hook becomes BotFeatureStopped with the failure as its cause",
	() =>
		Effect.gen(function* () {
			const registration = yield* fromPlugin("limited", limited).register()
			assert.isTrue(yield* registration.beforeStep!(step(1)))
			const before = yield* registration.beforeStep!(step(2)).pipe(Effect.flip)
			assert.ok(Schema.is(FeatureStopped)(before))
			assert.strictEqual(before.feature, "limited")
			assert.deepStrictEqual(before.cause, Stop.make({ step: 2 }))
			assert.strictEqual(
				before.message,
				"The bot feature limited stopped the Turn.",
			)
			const after = yield* registration.afterStep!({
				...step(3),
				chat: turn.chat,
				output: Prompt.empty,
				finishReason: "stop",
			}).pipe(Effect.flip)
			assert.deepStrictEqual(after.cause, Stop.make({ step: 3 }))
		}).pipe(Effect.scoped),
)

it.effect("the time limit keeps its duration and wraps its error", () =>
	Effect.gen(function* () {
		const registration = yield* fromPlugin("limited", limited).register()
		const limit = registration.timeLimit!
		assert.isTrue(Duration.equals(limit.duration, Duration.seconds(5)))
		const error = limit.error(Prompt.empty)
		assert.ok(Schema.is(FeatureStopped)(error))
		assert.deepStrictEqual(error.cause, Stop.make({ step: 0 }))
	}).pipe(Effect.scoped),
)

it.effect("a Bot plugin with no hooks gives a feature with no hook keys", () =>
	Effect.gen(function* () {
		const plain = Plugin.make({ id: Plugin.Id.make("plain") })(() =>
			Effect.succeed({ tools: {}, handlers: Context.empty() }),
		)
		const registration = yield* fromPlugin("plain", plain).register()
		assert.isFalse("beforeStep" in registration)
		assert.isFalse("afterStep" in registration)
		assert.isFalse("timeLimit" in registration)
	}).pipe(Effect.scoped),
)
