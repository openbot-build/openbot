import { assert, it } from "@effect/vitest"
import { Execution } from "@openbot-build/domain"
import { Cause, Duration, Effect, Exit, Schema } from "effect"
import { Prompt } from "effect/ai"
import * as BotFeatures from "@openbot-build/conversation-contract/chats/BotFeatures"
import * as TimeLimiter from "../src/TimeLimiter.ts"
import * as TimeLimiterFeature from "../src/TimeLimiterFeature.ts"

const fence = {
	namespace: "test",
	id: Execution.Id.make("execution"),
	generation: 1,
}
const decode = Schema.decodeUnknownExit(TimeLimiterFeature.Config)

it("the config takes milliseconds or a text as maxDuration", () => {
	for (const good of [{ maxDuration: 300 }, { maxDuration: "5 minutes" }])
		assert.isTrue(Exit.isSuccess(decode(good)), JSON.stringify(good))
	for (const bad of [
		{ maxDuration: 0 },
		{ maxDuration: -1 },
		{ maxDuration: Number.NaN },
		{ maxDuration: "NaN" },
		{ maxDuration: "0 seconds" },
		{ maxDuration: "Infinity" },
		{ maxDuration: "soon" },
		{},
	])
		assert.isTrue(Exit.isFailure(decode(bad)), JSON.stringify(bad))
})

it.effect("the feature keeps the limit of the config in milliseconds", () =>
	Effect.gen(function* () {
		const config = yield* Schema.decodeEffect(TimeLimiterFeature.Config)({
			maxDuration: "5 minutes",
		})
		const contribution = TimeLimiterFeature.contribution(config)
		assert.strictEqual(contribution.id, "@openbot-build/plugin-time-limiter")
		assert.strictEqual(contribution.version, 1)
		assert.strictEqual(contribution.order, 101)
		assert.isTrue(contribution.review)
		assert.deepStrictEqual(yield* contribution.settings, {
			maxDuration: 300000,
		})
	}),
)

it.effect("a Turn keeps the limit of its pin when the config changes", () =>
	Effect.gen(function* () {
		const features = yield* BotFeatures.make({ drain: "0 millis" })
		const contribution = TimeLimiterFeature.contribution({
			maxDuration: Duration.minutes(5),
		})
		yield* features.contribute(contribution)
		assert.deepStrictEqual(yield* features.snapshot, [
			{
				id: TimeLimiterFeature.id,
				version: 1,
				settings: { maxDuration: 300000 },
			},
		])
		// The pin of a Turn that started when the limit was 300 milliseconds.
		const [held] = yield* features.hold([
			{ id: TimeLimiterFeature.id, version: 1, settings: { maxDuration: 300 } },
		])
		const feature = yield* contribution.prepare(fence, held!.pin.settings)
		const registration = yield* feature.register()
		const limit = registration.timeLimit!
		assert.isTrue(Duration.equals(limit.duration, Duration.millis(300)))
		const stopped = limit.error(Prompt.empty)
		assert.ok(Schema.is(BotFeatures.FeatureStopped)(stopped))
		assert.strictEqual(stopped.feature, TimeLimiterFeature.id)
		const cause = stopped.cause
		assert.ok(Schema.is(TimeLimiter.TimeLimitExceeded)(cause))
		assert.isTrue(Duration.equals(cause.maxDuration, Duration.millis(300)))
	}).pipe(Effect.scoped),
)

it.effect("a pin that does not decode stops the phase with a defect", () =>
	Effect.gen(function* () {
		const exit = yield* TimeLimiterFeature.contribution({
			maxDuration: Duration.minutes(5),
		})
			.prepare(fence, { maxDuration: "5 minutes" })
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
