import { protect } from "../auth/Barrier.ts"
import { PlatformApi } from "@openbot-build/api"
import { Clock, DateTime, Effect, Layer } from "effect"
import { and, asc, eq, isNull, sql } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { platformAdmins } from "../database/Schema.ts"
import {
	normalizeEmail,
	PlatformAdmins,
	PlatformAdminsUnavailable,
} from "./PlatformAdmins.ts"

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis))
const view = (
	row: typeof platformAdmins.$inferSelect,
): PlatformApi.PlatformAdmin => ({
	email: row.email,
	userId: row.userId,
	addedAt: iso(row.addedAt),
})

export const make = Effect.gen(function* () {
	const db = yield* makeWithDefaults()
	const unavailable = () => PlatformAdminsUnavailable.make({})
	const byEmail = (email: string) => eq(platformAdmins.email, email)

	const service = PlatformAdmins.of({
		list: db
			.select()
			.from(platformAdmins)
			.orderBy(asc(platformAdmins.email))
			.pipe(
				Effect.map((rows) => rows.map(view)),
				Effect.mapError(unavailable),
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
					.where(byEmail(email))
				if (row === undefined) return yield* unavailable()
				return view(row)
			}).pipe(
				Effect.mapError((error) =>
					error._tag === "PlatformAdminsUnavailable" ? error : unavailable(),
				),
			),
		bind: (account) =>
			db
				.transaction((tx) =>
					Effect.gen(function* () {
						const email = normalizeEmail(account.email)
						const now = yield* Clock.currentTimeMillis
						yield* tx.execute(
							sql`SELECT pg_advisory_xact_lock(hashtextextended('openbot-platform-admins', 0))`,
						)
						const [existing] = yield* tx
							.select()
							.from(platformAdmins)
							.where(byEmail(email))
						if (
							existing !== undefined &&
							existing.userId !== null &&
							existing.userId !== account.userId
						)
							return yield* unavailable()
						const [row] = yield* tx
							.insert(platformAdmins)
							.values({ email, userId: account.userId, addedAt: now })
							.onConflictDoUpdate({
								target: platformAdmins.email,
								set: { userId: account.userId },
							})
							.returning()
						if (row === undefined) return yield* unavailable()
						return view(row)
					}),
				)
				.pipe(Effect.mapError(unavailable)),
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
						yield* tx.delete(platformAdmins).where(byEmail(email))
					}),
				)
				.pipe(
					Effect.mapError((error) =>
						error._tag === "PlatformAdminNotFound" ||
						error._tag === "LastPlatformAdmin"
							? error
							: unavailable(),
					),
				),
		check: (account) =>
			db
				.transaction((tx) =>
					Effect.gen(function* () {
						yield* tx.execute(
							sql`SELECT pg_advisory_xact_lock(hashtextextended('openbot-platform-admins', 0))`,
						)
						const [linked] = yield* tx
							.select({ email: platformAdmins.email })
							.from(platformAdmins)
							.where(eq(platformAdmins.userId, account.id))
						if (linked !== undefined) return true
						if (account.email === undefined || account.emailVerified !== true)
							return false
						// Link the account on the first sign-in. Only a verified email can claim the row.
						const claimed = yield* tx
							.update(platformAdmins)
							.set({ userId: account.id })
							.where(
								and(
									byEmail(normalizeEmail(account.email)),
									isNull(platformAdmins.userId),
								),
							)
							.returning({ email: platformAdmins.email })
						return claimed.length > 0
					}),
				)
				.pipe(Effect.mapError(unavailable)),
	})
	return PlatformAdmins.of({
		...service,
		bind: (...args) =>
			protect(service.bind(...args)).pipe(
				Effect.catchTag("AuthUnavailable", () => unavailable()),
			),
		add: (...args) =>
			protect(service.add(...args)).pipe(
				Effect.catchTag("AuthUnavailable", () => unavailable()),
			),
		remove: (...args) =>
			protect(service.remove(...args)).pipe(
				Effect.catchTag("AuthUnavailable", () => unavailable()),
			),
		check: (...args) =>
			protect(service.check(...args)).pipe(
				Effect.catchTag("AuthUnavailable", () => unavailable()),
			),
	})
})

export const layer = Layer.effect(PlatformAdmins, make)
