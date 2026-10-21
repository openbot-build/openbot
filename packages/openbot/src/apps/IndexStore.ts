import { AppIndexApi } from "@openbot-build/api"
import { Index } from "@openbot-build/protocol"
import { Effect, HashMap, Layer, Schema } from "effect"
import { and, eq } from "drizzle-orm"
import {
	makeWithDefaults,
	type EffectPgDatabase,
} from "drizzle-orm/effect-postgres"
import { appIndexEntries, appIndexJobs } from "../database/Schema.ts"
import { IndexNamespace } from "./IndexNamespace.ts"

/** The public Index entries in Postgres. It holds only entries that were checked independently. */
const unavailable = () =>
	new Index.IndexError({
		reason: "Unavailable",
		operation: "Public Index storage",
	})
export const decode = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Index.Entry),
)

/** The last check of each App in the namespace. An App that was never checked is pending. */
export const checks = (db: EffectPgDatabase, namespace: string) =>
	db
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
		)

export const layer = Layer.effect(
	Index.IndexStore,
	Effect.gen(function* () {
		const db = yield* makeWithDefaults()
		const namespace = yield* IndexNamespace
		const where = (cardUrl: string) =>
			and(
				eq(appIndexEntries.namespace, namespace),
				eq(appIndexEntries.cardUrl, cardUrl),
			)
		return Index.IndexStore.of({
			get: (cardUrl) =>
				db
					.select()
					.from(appIndexEntries)
					.where(where(cardUrl))
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
					.where(where(cardUrl))
					.pipe(Effect.asVoid, Effect.mapError(unavailable)),
		})
	}),
)
