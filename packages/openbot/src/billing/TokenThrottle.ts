import type { Settings as Limits } from "@openbot-build/domain"
import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Option,
	Schedule,
	Schema,
	Order,
} from "effect"
import { SqlClient } from "effect/sql"
import * as Background from "../execution/Background.ts"
import { tokenRateOf } from "../settings/Documents.ts"
import { Settings } from "../settings/Settings.ts"
import type { Attribution, Call } from "./Billing.ts"

/** One token bucket that a model call takes from. */
export interface Scope {
	readonly identity: {
		readonly organizationId: string
		readonly kind: keyof Limits.TokenRateLimits
		readonly subjectId: string
	}
	readonly rate: Limits.TokenRate
}

/** The shared token rates could not be read or changed. */
export class Unavailable extends Schema.TaggedError<
	Unavailable,
	{ readonly brand: unique symbol }
>()("TokenRateUnavailable", { cause: Schema.Defect() }) {}

/**
 * Token buckets that slow model work down instead of refusing it. Each bucket
 * fills at its rate up to its burst size. A taker may push a bucket into debt,
 * and then waits until every bucket of its call is out of debt again. Each
 * process uses the same PostgreSQL buckets and database clock.
 */
export class TokenThrottle extends Context.Service<
	TokenThrottle,
	{
		/** The buckets of a model call, from the platform and organization settings. */
		readonly scopes: (
			call: Call,
			attribution: Attribution,
		) => Effect.Effect<ReadonlyArray<Scope>, Unavailable>
		/** Takes tokens, then waits until no bucket is in debt. Zero tokens only waits. */
		readonly take: (
			scopes: ReadonlyArray<Scope>,
			tokens: number,
		) => Effect.Effect<void, Unavailable>
		/** Changes the count and returns its wait in milliseconds. Negative values give estimates back. */
		readonly charge: (
			scopes: ReadonlyArray<Scope>,
			tokens: number,
		) => Effect.Effect<number, Unavailable>
	}
>()("@openbot-build/openbot/billing/TokenThrottle") {}

/** The lower of two rates. Null means no limit. */
const lower = (
	a: Limits.TokenRate | null,
	b: Limits.TokenRate | null,
): Limits.TokenRate | null =>
	a === null
		? b
		: b === null
			? a
			: {
					tokensPerSecond: Math.min(a.tokensPerSecond, b.tokensPerSecond),
					burstTokens: Math.min(a.burstTokens, b.burstTokens),
				}

const identityOrder = Order.combineAll([
	Order.mapInput(Order.String, (scope: Scope) => scope.identity.organizationId),
	Order.mapInput(Order.String, (scope: Scope) => scope.identity.kind),
	Order.mapInput(Order.String, (scope: Scope) => scope.identity.subjectId),
])

export const make = Effect.gen(function* () {
	const background = yield* Background.make
	const settings = yield* Settings
	const sql = yield* SqlClient.SqlClient

	// A full bucket has the same state as a missing bucket. No work lives here.
	yield* background.repeat(
		sql`delete from openbot_token_buckets where level + tokens_per_second *
			greatest(0, extract(epoch from clock_timestamp()) * 1000 - updated_at) / 1000 >= burst_tokens`,
		{
			schedule: Schedule.spaced("1 minute"),
			message: "OpenBot could not drop full token buckets",
		},
	)

	const debit = (scopes: ReadonlyArray<Scope>, tokens: number) =>
		Effect.gen(function* () {
			// Every call takes its locks in the same order, even if its scopes differ.
			const ordered = Arr.sort(scopes, identityOrder)
			for (const { identity } of ordered) {
				yield* sql`select pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
					'model-token-rate', ${identity.organizationId}::text, ${identity.kind}::text,
					${identity.subjectId}::text)::text, 0))`
			}
			// Read time after the locks. Host clocks and lock waits cannot add tokens.
			const rows = yield* sql<{ readonly now: number }>`select
				extract(epoch from clock_timestamp())::float8 * 1000 as now`
			const now = yield* Schema.decodeUnknownEffect(Schema.Finite)(rows[0]?.now)
			let wait = 0
			for (const { identity, rate } of ordered) {
				const rows = yield* sql<{
					readonly level: number
				}>`insert into openbot_token_buckets
					(organization_id, kind, subject_id, level, updated_at, tokens_per_second, burst_tokens)
					values (${identity.organizationId}, ${identity.kind}, ${identity.subjectId},
						${Math.min(rate.burstTokens, rate.burstTokens - tokens)}, ${now},
						${rate.tokensPerSecond}, ${rate.burstTokens})
					on conflict (organization_id, kind, subject_id) do update set
						level = least(${rate.burstTokens}, least(${rate.burstTokens}, openbot_token_buckets.level +
							${rate.tokensPerSecond} * greatest(0, ${now} - openbot_token_buckets.updated_at) / 1000) - ${tokens}),
						updated_at = greatest(${now}, openbot_token_buckets.updated_at),
						tokens_per_second = ${rate.tokensPerSecond}, burst_tokens = ${rate.burstTokens}
					returning level`
				const level = yield* Schema.decodeUnknownEffect(Schema.Finite)(
					rows[0]?.level,
				)
				wait = Math.max(wait, Math.ceil((-level * 1000) / rate.tokensPerSecond))
			}
			return wait
		}).pipe(
			sql.withTransaction,
			Effect.timeout("30 seconds"),
			Effect.mapError((cause) => Unavailable.make({ cause })),
		)

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
				)
				const organization = yield* settings
					.organization(call.organizationId)
					.pipe(Effect.map((current) => tokenRateOf(current.document)))
				const rate = (scope: keyof Limits.TokenRateLimits) =>
					lower(platform?.[scope] ?? null, organization?.[scope] ?? null)
				const org = call.organizationId
				const candidates: ReadonlyArray<
					readonly [keyof Limits.TokenRateLimits, string | undefined]
				> = [
					["organization", org],
					["member", attribution.userId],
					["bot", attribution.botId],
					["token", attribution.tokenId],
				]
				return Arr.flatMap(candidates, ([kind, subjectId]) => {
					const value = rate(kind)
					return subjectId === undefined || value === null
						? []
						: [
								{
									identity: { organizationId: org, kind, subjectId },
									rate: value,
								},
							]
				})
			}).pipe(Effect.mapError((cause) => Unavailable.make({ cause }))),
		take: (scopes, tokens) =>
			scopes.length === 0
				? Effect.void
				: Effect.flatMap(debit(scopes, tokens), (wait) =>
						wait > 0 ? Effect.sleep(wait) : Effect.void,
					),
		charge: (scopes, tokens) =>
			scopes.length === 0 || tokens === 0
				? Effect.succeed(0)
				: debit(scopes, tokens),
	})
})

export const layer = Layer.effect(TokenThrottle, make)
