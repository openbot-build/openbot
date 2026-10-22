import { AuthApi, type Caller } from "@openbot-build/api"
import { lt, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schedule } from "effect"
import { rateWindows } from "../database/Schema.ts"
import { rateLimitOf } from "../settings/Documents.ts"
import { Settings } from "../settings/Settings.ts"
import * as Db from "../database/Database.ts"

const windowMs = 60_000

/**
 * Counts the requests of each caller in fixed windows of one minute. The count
 * lives in the database, so every instance shares it.
 */
export class RateLimiter extends Context.Service<
	RateLimiter,
	{
		/** Counts one request. It fails when the caller sent too many in this minute. */
		readonly hit: (caller: Caller) => Effect.Effect<void, AuthApi.RateLimited>
	}
>()("@openbot-build/openbot/billing/RateLimit/RateLimiter") {}

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const settings = yield* Settings
	// Old windows only take space. A background fiber removes them.
	yield* Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis
		yield* db
			.delete(rateWindows)
			.where(lt(rateWindows.windowStart, now - 2 * windowMs))
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.logWarning(
				"OpenBot could not remove old rate limit counts",
				cause,
			),
		),
		Effect.repeat(Schedule.spaced(windowMs)),
		Effect.forkScoped,
	)
	return RateLimiter.of({
		hit: (caller) =>
			Effect.gen(function* () {
				const platform = yield* settings.platform.pipe(
					Effect.orElseSucceed(() => Option.none()),
				)
				const limit = Option.match(platform, {
					onNone: () => null,
					onSome: (platform) =>
						rateLimitOf(platform.document).requestsPerMinute,
				})
				if (limit === null) return
				const now = yield* Clock.currentTimeMillis
				const windowStart = now - (now % windowMs)
				const key =
					caller.tokenId === undefined
						? "user:" + caller.userId
						: "token:" + caller.tokenId
				// When the database fails, the request goes on. The limit protects
				// the server, and other parts of the request fail anyway.
				const count = yield* db
					.insert(rateWindows)
					.values({ key, windowStart, count: 1 })
					.onConflictDoUpdate({
						target: [rateWindows.key, rateWindows.windowStart],
						set: { count: sql`${rateWindows.count} + 1` },
					})
					.returning({ count: rateWindows.count })
					.pipe(
						Effect.map((rows) => rows[0]?.count ?? 0),
						Effect.orElseSucceed(() => 0),
					)
				if (count > limit)
					return yield* AuthApi.RateLimited.make({
						retryAfterSeconds: Math.ceil((windowStart + windowMs - now) / 1000),
					})
			}),
	})
})

export const layer = Layer.effect(RateLimiter, make)
