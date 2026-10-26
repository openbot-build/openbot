import type { Settings as Api } from "@openbot-build/api"
import {
	Array as Arr,
	Clock,
	Context,
	Effect,
	HashMap,
	Layer,
	Option,
	Ref,
	Schedule,
} from "effect"
import * as Background from "../app/Background.ts"
import { tokenRateOf } from "../settings/Documents.ts"
import { Settings } from "../settings/Settings.ts"
import type { Attribution, Call } from "./Billing.ts"

/** One token bucket that a model call takes from. */
export interface Scope {
	readonly key: string
	readonly rate: Api.TokenRate
}

/**
 * Token buckets that slow model work down instead of refusing it. Each bucket
 * fills at its rate up to its burst size. A taker may push a bucket into debt,
 * and then waits until every bucket of its call is out of debt again. Each
 * instance keeps its own buckets in memory.
 */
export class TokenThrottle extends Context.Service<
	TokenThrottle,
	{
		/** The buckets of a model call, from the platform and organization settings. */
		readonly scopes: (
			call: Call,
			attribution: Attribution,
		) => Effect.Effect<ReadonlyArray<Scope>>
		/** Takes tokens, then waits until no bucket is in debt. Zero tokens only waits. */
		readonly take: (
			scopes: ReadonlyArray<Scope>,
			tokens: number,
		) => Effect.Effect<void>
		/** Takes tokens without waiting. The next taker of the same buckets waits instead. */
		readonly charge: (
			scopes: ReadonlyArray<Scope>,
			tokens: number,
		) => Effect.Effect<void>
	}
>()("@openbot-build/openbot/billing/TokenThrottle") {}

interface Bucket {
	/** Tokens in the bucket. Below 0 is debt. */
	readonly level: number
	readonly at: number
	readonly rate: Api.TokenRate
}

/** The lower of two rates. Null means no limit. */
const lower = (
	a: Api.TokenRate | null,
	b: Api.TokenRate | null,
): Api.TokenRate | null =>
	a === null
		? b
		: b === null
			? a
			: {
					tokensPerSecond: Math.min(a.tokensPerSecond, b.tokensPerSecond),
					burstTokens: Math.min(a.burstTokens, b.burstTokens),
				}

const refill = (bucket: Bucket, rate: Api.TokenRate, now: number): Bucket => ({
	level: Math.min(
		rate.burstTokens,
		bucket.level + (rate.tokensPerSecond * (now - bucket.at)) / 1000,
	),
	at: now,
	rate,
})

export const make = Effect.gen(function* () {
	const settings = yield* Settings
	const buckets = yield* Ref.make(HashMap.empty<string, Bucket>())

	// A full bucket is the same as no bucket, so a background fiber drops it.
	yield* Background.repeat(
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			yield* Ref.update(
				buckets,
				HashMap.filter(
					(bucket) =>
						refill(bucket, bucket.rate, now).level < bucket.rate.burstTokens,
				),
			)
		}),
		{
			schedule: Schedule.spaced("1 minute"),
			message: "OpenBot could not drop full token buckets",
		},
	)

	/** Takes tokens from each bucket, and gives the wait until the last one is out of debt. */
	const debit = (scopes: ReadonlyArray<Scope>, tokens: number) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			return yield* Ref.modify(buckets, (map) => {
				let next = map
				let wait = 0
				for (const scope of scopes) {
					const current = Option.getOrElse(
						HashMap.get(next, scope.key),
						() => ({
							level: scope.rate.burstTokens,
							at: now,
							rate: scope.rate,
						}),
					)
					const bucket = refill(current, scope.rate, now)
					const level = bucket.level - tokens
					next = HashMap.set(next, scope.key, { ...bucket, level })
					if (level < 0)
						wait = Math.max(
							wait,
							Math.ceil((-level * 1000) / scope.rate.tokensPerSecond),
						)
				}
				return [wait, next] as const
			})
		})

	return TokenThrottle.of({
		scopes: (call, attribution) =>
			Effect.gen(function* () {
				const platform = yield* settings.platform.pipe(
					Effect.map(
						Option.match({
							onNone: () => null,
							onSome: (current) => tokenRateOf(current.document),
						}),
					),
					// The throttle never refuses work, so the call goes on without limits.
					Effect.catchTag("SettingsUnavailable", (error) =>
						Effect.logWarning(
							"OpenBot could not read the platform token rates. The model call goes on without them.",
							error,
						).pipe(Effect.as(null)),
					),
				)
				const organization = yield* settings
					.organization(call.organizationId)
					.pipe(
						Effect.map((current) => tokenRateOf(current.document)),
						Effect.catchTag("SettingsUnavailable", (error) =>
							Effect.logWarning(
								"OpenBot could not read the token rates of the organization. The model call goes on without them.",
								error,
							).pipe(
								Effect.annotateLogs({ organizationId: call.organizationId }),
								Effect.as(null),
							),
						),
					)
				const rate = (scope: keyof Api.TokenRateLimits) =>
					lower(platform?.[scope] ?? null, organization?.[scope] ?? null)
				const org = call.organizationId
				const candidates: ReadonlyArray<
					readonly [keyof Api.TokenRateLimits, string | undefined]
				> = [
					["organization", "organization:" + org],
					[
						"member",
						attribution.userId && `member:${org}:${attribution.userId}`,
					],
					["bot", attribution.botId && `bot:${org}:${attribution.botId}`],
					[
						"token",
						attribution.tokenId && `token:${org}:${attribution.tokenId}`,
					],
				]
				return Arr.flatMap(candidates, ([scope, key]) => {
					const value = rate(scope)
					return key === undefined || value === null
						? []
						: [{ key, rate: value }]
				})
			}),
		take: (scopes, tokens) =>
			scopes.length === 0
				? Effect.void
				: Effect.flatMap(debit(scopes, tokens), (wait) =>
						wait > 0 ? Effect.sleep(wait) : Effect.void,
					),
		charge: (scopes, tokens) =>
			scopes.length === 0 || tokens <= 0
				? Effect.void
				: Effect.asVoid(debit(scopes, tokens)),
	})
})

export const layer = Layer.effect(TokenThrottle, make)
