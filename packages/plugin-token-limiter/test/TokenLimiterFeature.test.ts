import { assert, it } from "@effect/vitest"
import { Chat, type Plugin, Turn } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import { Cause, Effect, Exit, Schema } from "effect"
import { Prompt, Response } from "effect/ai"
import * as BotFeatures from "@openbot-build/conversation-contract/chats/BotFeatures"
import * as TokenLimiterFeature from "../src/TokenLimiterFeature.ts"

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
const usage = (tokens: number) => ({
	inputTokens: {
		total: tokens,
		uncached: tokens,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 0, text: 0, reasoning: undefined },
})
const step = (used: number): Plugin.StepInput => ({
	turn: { ...turn, usage: [Response.Usage.make(usage(used))] },
	kind: "model",
	step: 1,
	history: Prompt.empty,
})
const decode = Schema.decodeUnknownExit(TokenLimiterFeature.Config)

it("the config takes a whole number from 1 as maxTokens", () => {
	assert.isTrue(Exit.isSuccess(decode({ maxTokens: 1 })))
	assert.isTrue(Exit.isSuccess(decode({ maxTokens: 40 })))
	for (const bad of [
		{ maxTokens: 0 },
		{ maxTokens: -1 },
		{ maxTokens: 1.5 },
		{ maxTokens: Number.NaN },
		{ maxTokens: "NaN" },
		{ maxTokens: "5" },
		{},
	])
		assert.isTrue(Exit.isFailure(decode(bad)), JSON.stringify(bad))
})

it.effect("the feature keeps the limit of the config in its settings", () =>
	Effect.gen(function* () {
		const contribution = TokenLimiterFeature.contribution({ maxTokens: 5 })
		assert.strictEqual(contribution.id, "@openbot-build/plugin-token-limiter")
		assert.strictEqual(contribution.version, 1)
		assert.strictEqual(contribution.order, 102)
		assert.isTrue(contribution.review)
		assert.deepStrictEqual(yield* contribution.settings, { maxTokens: 5 })
	}),
)

it.effect("a Turn keeps the limit of its pin when the config changes", () =>
	Effect.gen(function* () {
		const features = yield* BotFeatures.make({ drain: "0 millis" })
		yield* features.contribute(
			TokenLimiterFeature.contribution({ maxTokens: 5 }),
		)
		assert.deepStrictEqual(yield* features.snapshot, [
			{
				id: TokenLimiterFeature.id,
				version: 1,
				settings: { maxTokens: 5 },
				missing: BotFeatures.skip,
			},
		])
		// The pin of a Turn that started when the limit was 1.
		const [held] = yield* features.hold([
			{
				id: TokenLimiterFeature.id,
				version: 1,
				settings: { maxTokens: 1 },
				missing: BotFeatures.skip,
			},
		])
		assert.deepStrictEqual(held!.pin.settings, { maxTokens: 1 })
		const feature = yield* TokenLimiterFeature.contribution({
			maxTokens: 5,
		}).prepare(fence, held!.pin.settings)
		const registration = yield* feature.register()
		assert.isTrue(yield* registration.beforeStep!(step(0)))
		const stopped = yield* registration.beforeStep!(step(1)).pipe(Effect.flip)
		assert.ok(Schema.is(BotFeatures.FeatureStopped)(stopped))
		assert.strictEqual(stopped.feature, TokenLimiterFeature.id)
		assert.strictEqual(stopped.category, "limited")
		const cause = stopped.cause
		assert.ok(Schema.is(TokenLimiterFeature.TokenLimitExceeded)(cause))
		assert.strictEqual(cause.maxTokens, 1)
		assert.strictEqual(cause.usedTokens, 1)
	}).pipe(Effect.scoped),
)

it.effect("a pin that does not decode stops the phase with a defect", () =>
	Effect.gen(function* () {
		const exit = yield* TokenLimiterFeature.contribution({ maxTokens: 5 })
			.prepare(fence, { maxTokens: "many" })
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
