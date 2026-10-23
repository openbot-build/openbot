// Each test is an entry point, so it provides its own layers.
// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
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
	agent: null,
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
	Effect.runPromise(
		effect.pipe(
			Effect.provide(
				TokenThrottle.layer.pipe(
					Layer.provide(settings(platform, organization)),
				),
			),
			Effect.scoped,
		),
	)

const elapsed = async <A>(work: () => Promise<A>) => {
	const start = performance.now()
	const value = await work()
	return { value, ms: performance.now() - start }
}

test("each scope uses the lower rate of the platform and the organization", async () => {
	const scopes = await run(
		Effect.flatMap(TokenThrottle.TokenThrottle, (throttle) =>
			throttle.scopes(call, {
				source: "turn",
				userId: "u_1",
				agentId: "agt_1",
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
			agent: { tokensPerSecond: 30, burstTokens: 30 },
			token: { tokensPerSecond: 5, burstTokens: 5 },
		},
	)
	assert.deepEqual(scopes, [
		{
			key: "organization:org_1",
			rate: { tokensPerSecond: 100, burstTokens: 10 },
		},
		{
			key: "member:org_1:u_1",
			rate: { tokensPerSecond: 10, burstTokens: 10 },
		},
		{
			key: "agent:org_1:agt_1",
			rate: { tokensPerSecond: 30, burstTokens: 30 },
		},
	])
})

test("a bucket in debt makes the next taker wait, and fills again over time", async () => {
	const rate = { tokensPerSecond: 1000, burstTokens: 100 }
	const result = await run(
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
})

test("a stream over the rate comes out slower but complete, and is never refused", async () => {
	const pieces = Array.from({ length: 40 }, (_, index) =>
		String(index).padStart(40, "x"),
	)
	const model = await Effect.runPromise(
		LanguageModel.make({
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
		}),
	)
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
	const free = await elapsed(() => answer(none))
	assert.equal(free.value, pieces.join(""))
	// 400 tokens with a burst of 100 at 2000 tokens each second: at least 150 ms.
	const slow = await elapsed(() =>
		answer({
			...none,
			organization: { tokensPerSecond: 2000, burstTokens: 100 },
		}),
	)
	assert.equal(slow.value, pieces.join(""))
	assert.ok(slow.ms >= 120, `the slow stream took ${slow.ms} ms`)
	assert.ok(slow.ms > free.ms + 80, `${slow.ms} ms against ${free.ms} ms`)
})
