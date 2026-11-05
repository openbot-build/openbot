import { Billing, type Caller } from "@openbot-build/domain"
import { lt, sql } from "drizzle-orm"
import { Cause, Clock, Context, Effect, Layer, Option, Schedule } from "effect"
import * as Background from "@openbot-build/server-kernel/execution/Background"
import { rateWindows } from "@openbot-build/server-database/Schema"
import { rateLimitOf } from "@openbot-build/server-kernel/settings/Documents"
import { Settings } from "@openbot-build/server-kernel/settings/Settings"
import * as Db from "@openbot-build/server-database/Database"
import * as Report from "@openbot-build/server-kernel/errors/Report"

const windowMs = 60_000

/**
 * Counts the requests of each caller in fixed windows of one minute. The count
 * lives in the database, so every instance shares it.
 */
export class RateLimiter extends Context.Service<
	RateLimiter,
	{
		/** Counts one request. It fails when the caller sent too many in this minute. */
		readonly hit: (caller: Caller) => Effect.Effect<void, Billing.RateLimited>
	}
	// @effect-diagnostics-next-line deterministicKeys:off -- The key keeps the name it had in the openbot package, so code built for that name still finds this service.
>()("@openbot-build/openbot/server-billing/billing/RateLimit/RateLimiter") {}

export const make = Effect.gen(function* () {
	const background = yield* Background.make
	const db = yield* Db.make
	const settings = yield* Settings
	const report = yield* Report.make
	// Old windows only take space. A background fiber removes them.
	yield* background.repeat(
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			yield* db
				.delete(rateWindows)
				.where(lt(rateWindows.windowStart, now - 2 * windowMs))
		}),
		{
			schedule: Schedule.spaced(windowMs),
			message: "OpenBot could not remove old rate limit counts",
		},
	)
	return RateLimiter.of({
		hit: (caller) =>
			Effect.gen(function* () {
				const platform = yield* settings.platform.pipe(
					Effect.catchTag("SettingsUnavailable", (error) =>
						report(
							"OpenBot could not read the request rate limit. The request goes on.",
							Cause.fail(error),
						).pipe(Effect.as(Option.none())),
					),
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
						Effect.catch((error) =>
							report(
								"OpenBot could not count a request for the rate limit. The request goes on.",
								Cause.fail(error),
							).pipe(Effect.as(0)),
						),
					)
				if (count > limit)
					return yield* Billing.RateLimited.make({
						retryAfterSeconds: Math.ceil((windowStart + windowMs - now) / 1000),
					})
			}),
	})
})

export const layer = Layer.effect(RateLimiter, make)
