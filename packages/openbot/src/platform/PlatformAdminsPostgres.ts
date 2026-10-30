import { Platform as PlatformModel } from "@openbot-build/domain"

import { Array as Arr, Cause, Clock, DateTime, Effect, Layer } from "effect"
import { and, asc, eq, isNull, sql } from "drizzle-orm"
import { platformAdmins, accountStates } from "../database/Schema.ts"
import {
	normalizeEmail,
	PlatformAdmins,
	PlatformAdminsUnavailable,
} from "./PlatformAdmins.ts"
import { openbot_auth_account } from "../database/AuthSchema.ts"
import * as Db from "../database/Database.ts"

const view = (
	row: typeof platformAdmins.$inferSelect,
): PlatformModel.PlatformAdmin => ({
	email: row.email,
	providerId: row.providerId,
	userId: row.userId,
	addedAt: DateTime.formatIso(DateTime.makeUnsafe(row.addedAt)),
})

const unavailable = (cause: unknown) =>
	PlatformAdminsUnavailable.make({ cause })
/** A row that must be in the database is not there. */
const missing = (what: string) =>
	unavailable(new Cause.NoSuchElementError(what))

export const make = Effect.gen(function* () {
	const db = yield* Db.make

	return PlatformAdmins.of({
		list: db
			.select()
			.from(platformAdmins)
			.orderBy(asc(platformAdmins.email))
			.pipe(Effect.map(Arr.map(view)), Effect.mapError(unavailable)),
		add: (input, providerId = "oidc") =>
			Effect.gen(function* () {
				const email = normalizeEmail(input)
				const now = yield* Clock.currentTimeMillis
				yield* db
					.insert(platformAdmins)
					.values({ email, providerId, userId: null, addedAt: now })
					.onConflictDoNothing()
				const [row] = yield* db
					.select()
					.from(platformAdmins)
					.where(eq(platformAdmins.email, email))
				// A remove at the same time can delete the row.
				if (row === undefined)
					return yield* missing(
						"The new platform admin is not in the database.",
					)
				return view(row)
			}).pipe(
				Effect.catchTag("EffectDrizzleQueryError", (error) =>
					Effect.fail(unavailable(error)),
				),
			),
		remove: (input) =>
			db
				.transaction((tx) =>
					Effect.gen(function* () {
						const email = normalizeEmail(input)
						yield* tx.execute(
							sql`SELECT pg_advisory_xact_lock(hashtextextended('openbot-platform-admins', 0))`,
						)
						const rows = yield* tx.select().from(platformAdmins)
						if (!Arr.some(rows, (row) => row.email === email))
							return yield* PlatformModel.PlatformAdminNotFound.make({ email })
						const states = yield* tx.select().from(accountStates)
						const active = Arr.filter(
							rows,
							(row) =>
								row.userId !== null &&
								!Arr.some(
									states,
									(s) => s.userId === row.userId && s.status === "suspended",
								),
						)
						if (
							rows.length === 1 ||
							(active.length === 1 && active[0]?.email === email)
						)
							return yield* PlatformModel.LastPlatformAdmin.make({})
						yield* tx
							.delete(platformAdmins)
							.where(eq(platformAdmins.email, email))
					}),
				)
				.pipe(
					Effect.catchTag(["EffectDrizzleQueryError", "SqlError"], (error) =>
						Effect.fail(unavailable(error)),
					),
				),
		check: (account) =>
			Effect.gen(function* () {
				const [state] = yield* db
					.select()
					.from(accountStates)
					.where(eq(accountStates.userId, account.id))
				if (state?.status === "suspended") return false
				const [linked] = yield* db
					.select({ email: platformAdmins.email })
					.from(platformAdmins)
					.where(eq(platformAdmins.userId, account.id))
				if (linked !== undefined) return true
				if (account.email === undefined || account.emailVerified !== true)
					return false
				const [provider] = yield* db
					.select({ providerId: openbot_auth_account.providerId })
					.from(openbot_auth_account)
					.innerJoin(
						platformAdmins,
						eq(platformAdmins.providerId, openbot_auth_account.providerId),
					)
					.where(
						and(
							eq(openbot_auth_account.userId, account.id),
							eq(platformAdmins.email, normalizeEmail(account.email)),
						),
					)
				if (provider === undefined) return false
				// Setup binds its email to the platform provider, never to another connection.
				const claimed = yield* db
					.update(platformAdmins)
					.set({ userId: account.id })
					.where(
						and(
							eq(platformAdmins.email, normalizeEmail(account.email)),
							isNull(platformAdmins.userId),
							eq(platformAdmins.providerId, provider.providerId),
						),
					)
					.returning({ email: platformAdmins.email })
				return claimed.length > 0
			}).pipe(Effect.mapError(unavailable)),
	})
})

export const layer = Layer.effect(PlatformAdmins, make)
