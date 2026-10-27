import { AppIndex } from "@openbot-build/domain"

import { Index } from "@openbot-build/protocol"
import { Effect, HashMap, Layer, Schema } from "effect"
import { and, eq } from "drizzle-orm"
import { appIndexEntries, appIndexJobs } from "../database/Schema.ts"
import { IndexNamespace } from "./IndexNamespace.ts"
import * as Db from "../database/Database.ts"

const EntryJson = Schema.fromJsonString(Index.Entry)
/** The JSON text of the last check of a job, in `app_index_jobs.check` and `app_index_results.check`. */
export const CheckJson = Schema.fromJsonString(AppIndex.Check)
/** The public Index entries in Postgres. It holds only entries that were checked independently. */
export const decode = Schema.decodeUnknownEffect(EntryJson)
/** The entry has its type already, so it always encodes. */
const encode = (entry: Index.Entry) =>
	Schema.encodeEffect(EntryJson)(entry).pipe(Effect.orDie)

/**
 * A database failure, or a stored row that does not decode. The error keeps
 * the failure as its cause, and the callers log it.
 */
const unavailable = Effect.mapError((cause: unknown) =>
	Index.IndexError.make({
		reason: "Unavailable",
		operation: "Public Index storage",
		cause,
	}),
)

/** The last check of each App in the namespace. An App that was never checked is pending. */
export const checks = (db: Db.Database, namespace: string) =>
	db
		.select()
		.from(appIndexJobs)
		.where(eq(appIndexJobs.namespace, namespace))
		.pipe(
			Effect.flatMap((rows) =>
				Effect.forEach(rows, (row) =>
					row.check === null
						? Effect.succeed([row.cardUrl, { _tag: "Pending" }] as const)
						: Schema.decodeEffect(Schema.fromJsonString(AppIndex.Check))(
								row.check,
							).pipe(Effect.map((check) => [row.cardUrl, check] as const)),
				),
			),
			Effect.map(HashMap.fromIterable),
			unavailable,
		)

export const layer = Layer.effect(
	Index.IndexStore,
	Effect.gen(function* () {
		const db = yield* Db.make
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
						unavailable,
					),
			upsert: (entry) =>
				encode(entry).pipe(
					Effect.flatMap((body) =>
						db
							.insert(appIndexEntries)
							.values({ namespace, cardUrl: entry.cardUrl, body })
							.onConflictDoUpdate({
								target: [appIndexEntries.namespace, appIndexEntries.cardUrl],
								set: { body },
							}),
					),
					Effect.as(entry),
					unavailable,
				),
			withdraw: (cardUrl) =>
				db
					.delete(appIndexEntries)
					.where(where(cardUrl))
					.pipe(Effect.asVoid, unavailable),
		})
	}),
)
