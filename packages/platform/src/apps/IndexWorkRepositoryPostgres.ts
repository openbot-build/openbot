import { AppIndexApi } from "@openbot-build/platform-api"
import { Discovery, Index } from "@openbot-build/protocol"
import type { PgClient } from "@effect/sql-pg"
import { Clock, Effect, Layer, Option, Schema } from "effect"
import { and, asc, eq, lte } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { appIndexJobs, appIndexResults } from "../database/Schema.ts"
import { IndexWorkRepository, type Job } from "./IndexWorkRepository.ts"

const unavailable = () =>
	new Index.IndexError({
		reason: "Unavailable",
		operation: "Public Index work storage",
	})
const checkCodec = Schema.fromJsonString(AppIndexApi.Check)
const sourcesCodec = Schema.fromJsonString(Schema.Array(Discovery.Source))
export const makeFor = (
	namespace: string,
): Effect.Effect<
	typeof IndexWorkRepository.Service,
	never,
	PgClient.PgClient
> =>
	Effect.gen(function* () {
		const db = yield* makeWithDefaults()
		const where = (cardUrl: string) =>
			and(
				eq(appIndexJobs.namespace, namespace),
				eq(appIndexJobs.cardUrl, cardUrl),
			)
		const job = (
			row: typeof appIndexJobs.$inferSelect,
		): Effect.Effect<Job, Schema.SchemaError> =>
			Effect.gen(function* () {
				const completed = row.generation === row.completedGeneration
				return {
					cardUrl: row.cardUrl,
					generation: row.generation,
					requestedAt: row.requestedAt,
					status: completed
						? "Completed"
						: row.claim === null
							? "Waiting"
							: "Verifying",
					check:
						completed && row.check !== null
							? yield* Schema.decodeEffect(checkCodec)(row.check)
							: null,
				}
			})
		const enqueue = (
			cardUrl: string,
			sources: ReadonlyArray<Discovery.Source>,
		) =>
			db
				.transaction((tx) =>
					Effect.gen(function* () {
						yield* tx
							.insert(appIndexJobs)
							.values({ namespace, cardUrl, nextCheckAt: 0 })
							.onConflictDoNothing()
						const row = (yield* tx
							.select()
							.from(appIndexJobs)
							.where(where(cardUrl))
							.for("update"))[0]
						if (row === undefined) return yield* unavailable()
						const previousSources = yield* Schema.decodeEffect(sourcesCodec)(
							row.sources,
						)
						const combined = [...previousSources, ...sources].filter(
							(source, index, values) =>
								values.findIndex(
									(value) =>
										value.role === source.role && value.url === source.url,
								) === index,
						)
						const encoded = yield* Schema.encodeEffect(sourcesCodec)(combined)
						const pending =
							row.generation !== "" &&
							row.generation !== row.completedGeneration
						const next = pending
							? { ...row, sources: encoded }
							: {
									...row,
									generation: yield* Effect.sync(() => crypto.randomUUID()),
									sources: encoded,
									requestedAt: yield* Clock.currentTimeMillis,
									startedAt: 0,
									nextCheckAt: 0,
								}
						yield* tx.update(appIndexJobs).set(next).where(where(cardUrl))
						return yield* job(next)
					}),
				)
				.pipe(Effect.mapError(unavailable))
		return IndexWorkRepository.of({
			restart: db
				.update(appIndexJobs)
				.set({ claim: null, leaseUntil: 0 })
				.where(eq(appIndexJobs.namespace, namespace))
				.pipe(Effect.asVoid, Effect.mapError(unavailable)),
			enqueue,
			get: (cardUrl, generation) =>
				Effect.gen(function* () {
					const row = (yield* db
						.select()
						.from(appIndexJobs)
						.where(where(cardUrl)))[0]
					if (
						generation !== undefined &&
						(row === undefined || row.generation !== generation)
					) {
						const result = (yield* db
							.select()
							.from(appIndexResults)
							.where(
								and(
									eq(appIndexResults.namespace, namespace),
									eq(appIndexResults.cardUrl, cardUrl),
									eq(appIndexResults.generation, generation),
								),
							))[0]
						if (result === undefined) return Option.none()
						return Option.some<Job>({
							cardUrl,
							generation,
							status: "Completed",
							requestedAt: result.finishedAt,
							check: yield* Schema.decodeEffect(checkCodec)(result.check),
						})
					}
					return row === undefined
						? Option.none()
						: Option.some(yield* job(row))
				}).pipe(Effect.mapError(unavailable)),
			claim: (cardUrl) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const token = yield* Effect.sync(() => crypto.randomUUID())
					return yield* db.transaction((tx) =>
						Effect.gen(function* () {
							const row = (yield* tx
								.select()
								.from(appIndexJobs)
								.where(
									and(
										eq(appIndexJobs.namespace, namespace),
										lte(appIndexJobs.nextCheckAt, now),
										lte(appIndexJobs.leaseUntil, now),
										cardUrl === undefined
											? undefined
											: eq(appIndexJobs.cardUrl, cardUrl),
									),
								)
								.orderBy(
									asc(appIndexJobs.nextCheckAt),
									asc(appIndexJobs.cardUrl),
								)
								.limit(1)
								.for("update", { skipLocked: true }))[0]
							if (row === undefined) return Option.none()
							const generation =
								row.generation === "" ||
								row.generation === row.completedGeneration
									? yield* Effect.sync(() => crypto.randomUUID())
									: row.generation
							yield* tx
								.update(appIndexJobs)
								.set({
									generation,
									claim: token,
									leaseUntil: now + 300000,
									startedAt: now,
									requestedAt:
										generation === row.generation ? row.requestedAt : now,
								})
								.where(where(row.cardUrl))
							return Option.some({
								cardUrl: row.cardUrl,
								token,
								generation,
								sources: yield* Schema.decodeEffect(sourcesCodec)(row.sources),
							})
						}),
					)
				}).pipe(Effect.mapError(unavailable)),
			finish: (claim, check, nextCheckAt) =>
				db
					.transaction((tx) =>
						Effect.gen(function* () {
							const encoded = yield* Schema.encodeEffect(checkCodec)(check)
							const rows = yield* tx
								.update(appIndexJobs)
								.set({
									check: encoded,
									completedGeneration: claim.generation,
									nextCheckAt,
									leaseUntil: 0,
									claim: null,
								})
								.where(
									and(
										where(claim.cardUrl),
										eq(appIndexJobs.claim, claim.token),
									),
								)
								.returning({ generation: appIndexJobs.generation })
							const [finished] = rows
							if (rows.length !== 1 || finished === undefined)
								return yield* unavailable()
							yield* tx
								.insert(appIndexResults)
								.values({
									namespace,
									cardUrl: claim.cardUrl,
									generation: finished.generation,
									check: encoded,
									finishedAt: yield* Clock.currentTimeMillis,
								})
								.onConflictDoNothing()
						}),
					)
					.pipe(Effect.asVoid, Effect.mapError(unavailable)),
			release: (claim) =>
				db
					.update(appIndexJobs)
					.set({ leaseUntil: 0, claim: null })
					.where(and(where(claim.cardUrl), eq(appIndexJobs.claim, claim.token)))
					.pipe(Effect.asVoid, Effect.mapError(unavailable)),
		})
	})
export const make = makeFor("public")
export const layerFor = (namespace: string) =>
	Layer.effect(IndexWorkRepository, makeFor(namespace))
export const layer = layerFor("public")
