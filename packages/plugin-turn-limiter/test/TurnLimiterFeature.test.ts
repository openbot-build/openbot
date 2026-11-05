import { assert, it } from "@effect/vitest"
import { Chat, type Plugin, Turn } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import { Cause, Effect, Exit, Schema } from "effect"
import { Prompt } from "effect/ai"
import * as BotFeatures from "@openbot-build/conversation-contract/chats/BotFeatures"
import * as TurnLimiter from "../src/TurnLimiter.ts"
import * as TurnLimiterFeature from "../src/TurnLimiterFeature.ts"

const fence = {
	namespace: "test",
	id: Execution.Id.make("execution"),
	generation: 1,
}
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
const decode = Schema.decodeUnknownExit(TurnLimiterFeature.Config)

it("the config takes a whole number from 1 as maxSteps", () => {
	assert.isTrue(Exit.isSuccess(decode({ maxSteps: 1 })))
	assert.isTrue(Exit.isSuccess(decode({ maxSteps: 40 })))
	for (const bad of [
		{ maxSteps: 0 },
		{ maxSteps: -1 },
		{ maxSteps: 1.5 },
		{ maxSteps: Number.NaN },
		{ maxSteps: "NaN" },
		{ maxSteps: "5" },
		{},
	])
		assert.isTrue(Exit.isFailure(decode(bad)), JSON.stringify(bad))
})

it.effect("the feature keeps the limit of the config in its settings", () =>
	Effect.gen(function* () {
		const contribution = TurnLimiterFeature.contribution({ maxSteps: 5 })
		assert.strictEqual(contribution.id, "@openbot-build/plugin-turn-limiter")
		assert.strictEqual(contribution.version, 1)
		assert.strictEqual(contribution.order, 100)
		assert.isTrue(contribution.review)
		assert.deepStrictEqual(yield* contribution.settings, { maxSteps: 5 })
	}),
)

it.effect("a Turn keeps the limit of its pin when the config changes", () =>
	Effect.gen(function* () {
		const features = yield* BotFeatures.make({ drain: "0 millis" })
		yield* features.contribute(TurnLimiterFeature.contribution({ maxSteps: 5 }))
		assert.deepStrictEqual(yield* features.snapshot, [
			{
				id: TurnLimiterFeature.id,
				version: 1,
				settings: { maxSteps: 5 },
			},
		])
		// The pin of a Turn that started when the limit was 1.
		const [held] = yield* features.hold([
			{ id: TurnLimiterFeature.id, version: 1, settings: { maxSteps: 1 } },
		])
		assert.deepStrictEqual(held!.pin.settings, { maxSteps: 1 })
		const feature = yield* TurnLimiterFeature.contribution({
			maxSteps: 5,
		}).prepare(fence, held!.pin.settings)
		const registration = yield* feature.register()
		assert.isTrue(yield* registration.beforeStep!(step(1)))
		const stopped = yield* registration.beforeStep!(step(2)).pipe(Effect.flip)
		assert.ok(Schema.is(BotFeatures.FeatureStopped)(stopped))
		assert.strictEqual(stopped.feature, TurnLimiterFeature.id)
		const cause = stopped.cause
		assert.ok(Schema.is(TurnLimiter.ModelStepLimitExceeded)(cause))
		assert.strictEqual(cause.maxSteps, 1)
	}).pipe(Effect.scoped),
)

it.effect("a pin that does not decode stops the phase with a defect", () =>
	Effect.gen(function* () {
		const exit = yield* TurnLimiterFeature.contribution({ maxSteps: 5 })
			.prepare(fence, { maxSteps: "many" })
			.pipe(Effect.exit)
		assert.isTrue(Exit.isFailure(exit))
		if (Exit.isFailure(exit)) {
			assert.isTrue(Cause.hasDies(exit.cause))
			assert.ok(
				Schema.isSchemaError(Cause.squash(exit.cause)),
				Cause.pretty(exit.cause),
			)
		}
	}).pipe(Effect.scoped),
)
