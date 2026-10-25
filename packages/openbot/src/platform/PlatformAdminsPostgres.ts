import { PlatformApi } from "@openbot-build/api"
import { Clock, DateTime, Effect, Layer } from "effect"
import { and, asc, eq, isNull, sql } from "drizzle-orm"
import { platformAdmins } from "../database/Schema.ts"
import {
	normalizeEmail,
	PlatformAdmins,
	PlatformAdminsUnavailable,
} from "./PlatformAdmins.ts"
import * as Db from "../database/Database.ts"

const view = (
	row: typeof platformAdmins.$inferSelect,
): PlatformApi.PlatformAdmin => ({
	email: row.email,
	userId: row.userId,
	addedAt: DateTime.formatIso(DateTime.makeUnsafe(row.addedAt)),
})

export const make = Effect.gen(function* () {
	const db = yield* Db.make

	return PlatformAdmins.of({
		list: db
			.select()
			.from(platformAdmins)
			.orderBy(asc(platformAdmins.email))
			.pipe(
				Effect.map((rows) => rows.map(view)),
				Effect.mapError(() => PlatformAdminsUnavailable.make({})),
			),
		add: (input) =>
			Effect.gen(function* () {
				const email = normalizeEmail(input)
				const now = yield* Clock.currentTimeMillis
				yield* db
					.insert(platformAdmins)
					.values({ email, userId: null, addedAt: now })
					.onConflictDoNothing()
				const [row] = yield* db
					.select()
					.from(platformAdmins)
					.where(eq(platformAdmins.email, email))
				if (row === undefined) return yield* PlatformAdminsUnavailable.make({})
				return view(row)
			}).pipe(
				Effect.mapError((error) =>
					error._tag === "PlatformAdminsUnavailable"
						? error
						: PlatformAdminsUnavailable.make({}),
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
						if (!rows.some((row) => row.email === email))
							return yield* PlatformApi.PlatformAdminNotFound.make({ email })
						if (rows.length === 1)
							return yield* PlatformApi.LastPlatformAdmin.make({})
						yield* tx
							.delete(platformAdmins)
							.where(eq(platformAdmins.email, email))
					}),
				)
				.pipe(
					Effect.mapError((error) =>
						error._tag === "PlatformAdminNotFound" ||
						error._tag === "LastPlatformAdmin"
							? error
							: PlatformAdminsUnavailable.make({}),
					),
				),
		check: (account) =>
			Effect.gen(function* () {
				const [linked] = yield* db
					.select({ email: platformAdmins.email })
					.from(platformAdmins)
					.where(eq(platformAdmins.userId, account.id))
				if (linked !== undefined) return true
				if (account.email === undefined || account.emailVerified !== true)
					return false
				// Link the account on the first sign-in. Only a verified email can claim the row.
				const claimed = yield* db
					.update(platformAdmins)
					.set({ userId: account.id })
					.where(
						and(
							eq(platformAdmins.email, normalizeEmail(account.email)),
							isNull(platformAdmins.userId),
						),
					)
					.returning({ email: platformAdmins.email })
				return claimed.length > 0
			}).pipe(Effect.mapError(() => PlatformAdminsUnavailable.make({}))),
	})
})

export const layer = Layer.effect(PlatformAdmins, make)
