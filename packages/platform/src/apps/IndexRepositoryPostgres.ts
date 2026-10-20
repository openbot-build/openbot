import { AppIndexApi } from "@openbot-build/platform-api"
import { Index } from "@openbot-build/protocol"
import type { PgClient } from "@effect/sql-pg"
import { Effect, HashMap, Layer, Schema } from "effect"
import { and, eq } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { appIndexEntries, appIndexJobs } from "../database/Schema.ts"
import { IndexRepository } from "./IndexRepository.ts"

const unavailable = () =>
	new Index.IndexError({
		reason: "Unavailable",
		operation: "Public Index storage",
	})
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Index.Entry))

export const makeFor = (
	namespace: string,
): Effect.Effect<typeof IndexRepository.Service, never, PgClient.PgClient> =>
	Effect.gen(function* () {
		const db = yield* makeWithDefaults()
		return IndexRepository.of({
			list: db
				.select()
				.from(appIndexEntries)
				.where(eq(appIndexEntries.namespace, namespace))
				.pipe(
					Effect.flatMap((rows) =>
						Effect.forEach(rows, (row) => decode(row.body)),
					),
					Effect.mapError(unavailable),
				),
			checks: db
				.select()
				.from(appIndexJobs)
				.where(eq(appIndexJobs.namespace, namespace))
				.pipe(
					Effect.flatMap((rows) =>
						Effect.forEach(rows, (row) =>
							row.check === null
								? Effect.succeed([row.cardUrl, { _tag: "Pending" }] as const)
								: Schema.decodeEffect(Schema.fromJsonString(AppIndexApi.Check))(
										row.check,
									).pipe(Effect.map((check) => [row.cardUrl, check] as const)),
						),
					),
					Effect.map(HashMap.fromIterable),
					Effect.mapError(unavailable),
				),
			get: (cardUrl) =>
				db
					.select()
					.from(appIndexEntries)
					.where(
						and(
							eq(appIndexEntries.namespace, namespace),
							eq(appIndexEntries.cardUrl, cardUrl),
						),
					)
					.pipe(
						Effect.flatMap((rows) =>
							rows[0] === undefined
								? Effect.succeedNone
								: decode(rows[0].body).pipe(Effect.asSome),
						),
						Effect.mapError(unavailable),
					),
			upsert: (entry) =>
				db
					.insert(appIndexEntries)
					.values({
						namespace,
						cardUrl: entry.cardUrl,
						body: JSON.stringify(entry),
					})
					.onConflictDoUpdate({
						target: [appIndexEntries.namespace, appIndexEntries.cardUrl],
						set: { body: JSON.stringify(entry) },
					})
					.pipe(Effect.as(entry), Effect.mapError(unavailable)),
			withdraw: (cardUrl) =>
				db
					.delete(appIndexEntries)
					.where(
						and(
							eq(appIndexEntries.namespace, namespace),
							eq(appIndexEntries.cardUrl, cardUrl),
						),
					)
					.pipe(Effect.asVoid, Effect.mapError(unavailable)),
		})
	})

export const make = makeFor("public")
export const layerFor = (namespace: string) =>
	Layer.effect(IndexRepository, makeFor(namespace))
export const layer = layerFor("public")
export const layerProtocol = Layer.effect(
	Index.IndexStore,
	Effect.map(IndexRepository, (repository) => Index.IndexStore.of(repository)),
)
