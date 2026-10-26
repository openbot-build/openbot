import { assert, it } from "@effect/vitest"
import { type Settings as Api, Authorization } from "@openbot-build/api"
import {
	Array as Arr,
	Duration,
	Effect,
	Fiber,
	Layer,
	pipe,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, Response } from "effect/ai"
import { TestClock } from "effect/testing"
import { meter } from "../src/billing/MeteredModel.ts"
import * as TokenThrottle from "../src/billing/TokenThrottle.ts"
import { organizationDefaults } from "../src/settings/Documents.ts"
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
	Layer.mock(Settings, {
		platform: Effect.succeedSome({
			document: {
				publicOrigin: "https://openbot.example.com",
				authSecret: "unused",
				identityProvider: null,
				organizationCreation: "anyone" as const,
				ceiling: Authorization.emptyPolicy,
				appRestrictions: [],
				tokenRate: platform,
			},
			version: 1,
			updatedAt: 0,
		}),
		organization: () =>
			Effect.succeed({
				document: { ...organizationDefaults, tokenRate: organization },
				version: 1,
				updatedAt: 0,
			}),
	})

/** A Billing that lets every call through and records nothing. */
const billing = {
	check: () => Effect.void,
	record: () => Effect.void,
} as never

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

/** Runs the effect, and gives its value and the time it took in milliseconds. */
const elapsed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.map(Effect.timed(effect), ([duration, value]) => ({
		value,
		ms: Duration.toMillis(duration),
	}))

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

it.effect(
	"a bucket in debt makes the next taker wait, and fills again over time",
	() =>
		Effect.gen(function* () {
			const rate = { tokensPerSecond: 1000, burstTokens: 100 }
			const burst = yield* run(
				Effect.gen(function* () {
					const throttle = yield* TokenThrottle.TokenThrottle
					const scopes = [{ key: "organization:org_1", rate }]
					// The full bucket gives the first 100 tokens at once.
					const burst = yield* elapsed(throttle.take(scopes, 100))
					// 150 more tokens: 150 ms at 1000 tokens each second.
					yield* throttle.charge(scopes, 150)
					const fiber = yield* Effect.forkChild(throttle.take(scopes, 0), {
						startImmediately: true,
					})
					yield* TestClock.adjust("149 millis")
					assert.strictEqual(fiber.pollUnsafe(), undefined)
					yield* TestClock.adjust("1 millis")
					yield* Fiber.join(fiber)
					return burst
				}),
				{ ...none, organization: rate },
			)
			assert.strictEqual(burst.ms, 0)
		}),
)

it.effect(
	"a stream over the rate comes out slower but complete, and is never refused",
	() =>
		Effect.gen(function* () {
			const pieces = Arr.makeBy(40, (index) =>
				Str.padStart(40, "x")(String(index)),
			)
			const model = yield* LanguageModel.make({
				generateText: () => Effect.succeed([]),
				streamText: () =>
					Stream.fromIterable<Response.StreamPartEncoded>([
						Response.makePart("text-start", { id: "text" }),
						...Arr.map(pieces, (delta) =>
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
						const metered = meter(model, call, { billing, throttle })
						const parts = yield* metered
							.streamText({ prompt: "Write" })
							.pipe(Stream.runCollect, Effect.orDie)
						return pipe(
							parts,
							Arr.filter((part) => part.type === "text-delta"),
							Arr.map((part) => part.delta),
							Arr.join(""),
						)
					}),
					platform,
				)
			const free = yield* elapsed(answer(none))
			assert.strictEqual(free.value, Arr.join(pieces, ""))
			assert.strictEqual(free.ms, 0)
			const fiber = yield* Effect.forkChild(
				elapsed(
					answer({
						...none,
						organization: { tokensPerSecond: 2000, burstTokens: 100 },
					}),
				),
			)
			// The stream starts each wait some steps after the one before, so one
			// big move of the clock can go past a wait that is not there yet.
			// The clock moves 1 ms at a time until the stream ends.
			yield* TestClock.adjust("1 millis").pipe(
				Effect.repeat({ until: () => fiber.pollUnsafe() !== undefined }),
			)
			const slow = yield* Fiber.join(fiber)
			assert.strictEqual(slow.value, Arr.join(pieces, ""))
			// 400 tokens with a burst of 100 at 2000 tokens each second: 150 ms.
			assert.ok(slow.ms >= 150, `the slow stream took ${slow.ms} ms`)
			assert.ok(slow.ms < 160, `the slow stream took ${slow.ms} ms`)
		}),
)
