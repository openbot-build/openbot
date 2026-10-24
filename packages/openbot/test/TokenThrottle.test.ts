// Each test is an entry point, so it provides its own layers.
// @effect-diagnostics strictEffectProvide:off
import { assert, it } from "@effect/vitest"
import type { Settings as Api } from "@openbot-build/api"
import { Effect, Layer, Stream } from "effect"
import { LanguageModel, Response } from "effect/ai"
import { meter } from "../src/billing/MeteredModel.ts"
import * as TokenThrottle from "../src/billing/TokenThrottle.ts"
import { Settings } from "../src/settings/Settings.ts"

const call = {
	organizationId: "org_1",
	providerId: "prov_1",
	providerOwner: "platform" as const,
	modelId: "model_1",
}
const none: Api.TokenRateLimits = {
	organization: null,
	member: null,
	bot: null,
	token: null,
}

/** Settings with only the token rates of the platform and of the organization. */
const settings = (
	platform: Api.TokenRateLimits,
	organization: Api.TokenRateLimits,
) =>
	Layer.succeed(Settings, {
		platform: Effect.succeedSome({
			document: { tokenRate: platform },
			version: 1,
			updatedAt: 0,
		}),
		organization: () =>
			Effect.succeed({
				document: { tokenRate: organization },
				version: 1,
				updatedAt: 0,
			}),
	} as never)

const run = <A>(
	effect: Effect.Effect<A, never, TokenThrottle.TokenThrottle>,
	platform: Api.TokenRateLimits,
	organization: Api.TokenRateLimits = none,
) =>
	effect.pipe(
		Effect.provide(
			TokenThrottle.layer.pipe(Layer.provide(settings(platform, organization))),
		),
		Effect.scoped,
	)

/** Runs the effect, and gives its value and the real time it took. */
const elapsed = <A, E>(effect: Effect.Effect<A, E>) =>
	Effect.gen(function* () {
		const start = performance.now()
		const value = yield* effect
		return { value, ms: performance.now() - start }
	})

it.effect(
	"each scope uses the lower rate of the platform and the organization",
	() =>
		Effect.gen(function* () {
			const scopes = yield* run(
				Effect.flatMap(TokenThrottle.TokenThrottle, (throttle) =>
					throttle.scopes(call, {
						source: "turn",
						userId: "u_1",
						botId: "bot_1",
					}),
				),
				{
					...none,
					organization: { tokensPerSecond: 100, burstTokens: 50 },
					member: { tokensPerSecond: 10, burstTokens: 10 },
				},
				{
					...none,
					organization: { tokensPerSecond: 200, burstTokens: 10 },
					bot: { tokensPerSecond: 30, burstTokens: 30 },
					token: { tokensPerSecond: 5, burstTokens: 5 },
				},
			)
			assert.deepStrictEqual(scopes, [
				{
					key: "organization:org_1",
					rate: { tokensPerSecond: 100, burstTokens: 10 },
				},
				{
					key: "member:org_1:u_1",
					rate: { tokensPerSecond: 10, burstTokens: 10 },
				},
				{
					key: "bot:org_1:bot_1",
					rate: { tokensPerSecond: 30, burstTokens: 30 },
				},
			])
		}),
)

// The throttle waits in real time, so this test needs the real clock.
it.live(
	"a bucket in debt makes the next taker wait, and fills again over time",
	() =>
		Effect.gen(function* () {
			const rate = { tokensPerSecond: 1000, burstTokens: 100 }
			const result = yield* run(
				Effect.gen(function* () {
					const throttle = yield* TokenThrottle.TokenThrottle
					const scopes = [{ key: "organization:org_1", rate }]
					const time = (effect: Effect.Effect<void>) =>
						Effect.gen(function* () {
							const start = performance.now()
							yield* effect
							return performance.now() - start
						})
					// The full bucket gives the first 100 tokens at once.
					const burst = yield* time(throttle.take(scopes, 100))
					// 150 more tokens: 150 ms at 1000 tokens each second.
					yield* throttle.charge(scopes, 150)
					const debt = yield* time(throttle.take(scopes, 0))
					return { burst, debt }
				}),
				{ ...none, organization: rate },
			)
			assert.ok(result.burst < 30, `burst took ${result.burst} ms`)
			assert.ok(result.debt >= 120, `debt took ${result.debt} ms`)
			assert.ok(result.debt < 1000, `debt took ${result.debt} ms`)
		}),
)

// The throttle waits in real time, so this test needs the real clock.
it.live(
	"a stream over the rate comes out slower but complete, and is never refused",
	() =>
		Effect.gen(function* () {
			const pieces = Array.from({ length: 40 }, (_, index) =>
				String(index).padStart(40, "x"),
			)
			const model = yield* LanguageModel.make({
				generateText: () => Effect.succeed([]),
				streamText: () =>
					Stream.fromIterable<Response.StreamPartEncoded>([
						Response.makePart("text-start", { id: "text" }),
						...pieces.map((delta) =>
							Response.makePart("text-delta", { id: "text", delta }),
						),
						Response.makePart("text-end", { id: "text" }),
						Response.makePart("finish", {
							reason: "stop",
							usage: {
								inputTokens: { total: 0, uncached: 0, cacheRead: 0 },
								outputTokens: { total: 400, text: 400, reasoning: 0 },
							},
						}),
					]),
			})
			/** Streams the answer through a metered model, and gives the text. */
			const answer = (platform: Api.TokenRateLimits) =>
				run(
					Effect.gen(function* () {
						const throttle = yield* TokenThrottle.TokenThrottle
						const metered = meter(model, call, { throttle })
						const parts = yield* metered
							.streamText({ prompt: "Write" })
							.pipe(Stream.runCollect, Effect.orDie)
						return parts
							.filter((part) => part.type === "text-delta")
							.map((part) => part.delta)
							.join("")
					}),
					platform,
				)
			const free = yield* elapsed(answer(none))
			assert.strictEqual(free.value, pieces.join(""))
			// 400 tokens with a burst of 100 at 2000 tokens each second: at least 150 ms.
			const slow = yield* elapsed(
				answer({
					...none,
					organization: { tokensPerSecond: 2000, burstTokens: 100 },
				}),
			)
			assert.strictEqual(slow.value, pieces.join(""))
			assert.ok(slow.ms >= 120, `the slow stream took ${slow.ms} ms`)
			assert.ok(slow.ms > free.ms + 80, `${slow.ms} ms against ${free.ms} ms`)
		}),
)
