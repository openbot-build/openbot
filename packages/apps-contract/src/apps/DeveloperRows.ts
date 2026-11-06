/**
 * The Developer Center tables in Postgres: the codecs between rows and product
 * values, and the queries that more than one Developer module uses.
 * Every table has a `namespace` column, so the development host keeps its own rows.
 */

import type { Database } from "@openbot-build/server-database/Database"
import { transactionFailures as stored } from "@openbot-build/server-execution/Store"
import { Developers } from "@openbot-build/domain"
import { Discovery } from "@openbot-build/protocol"
import { InstanceSettings } from "@openbot-build/server-kernel/InstanceSettings"
import { and, eq } from "drizzle-orm"
import { Array as Arr, Effect, Option, Schema } from "effect"
import {
	developerApps,
	developerProofs,
} from "@openbot-build/server-database/Schema"

/**
 * The namespace of the App rows of this instance, such as Index jobs, Index
 * entries and Developer Center rows. A development instance uses its own
 * namespace, so its checks never reach the public Index.
 */
export const instanceNamespace = Effect.map(InstanceSettings, (instance) =>
	instance.development ? "development" : "public",
)

/** A column that holds a value as JSON text. */
export const Json = <S extends Schema.Top>(schema: S) =>
	Schema.fromJsonString(Schema.toCodecJson(schema))

/** Read a stored value. A value that does not match the schema means the storage is broken. */
export const decodeRow =
	<S extends Schema.Top>(schema: S) =>
	(row: unknown) =>
		Schema.decodeUnknownEffect(schema)(row)

export const ProofRow = Schema.Struct({
	...Developers.Proof.fields,
	scope: Json(Developers.ManagementScope),
})

export interface ProofRecord {
	readonly owner: string
	readonly token: string
	readonly value: Developers.Proof
}

export const decodeProof = (row: typeof developerProofs.$inferSelect) =>
	decodeRow(ProofRow)(row).pipe(
		Effect.map((value): ProofRecord => ({
			owner: row.owner,
			token: row.token,
			value,
		})),
	)

const AppRow = Schema.Struct({
	cardUrl: Schema.String,
	candidate: Json(Discovery.Candidate),
	nextCheckAt: Schema.Finite,
	leaseUntil: Schema.Finite,
	monitorToken: Schema.NullOr(Schema.String),
	monitorRevision: Schema.Natural,
	monitorIssues: Json(Schema.Array(Developers.Issue)),
})

export const decodeApp = decodeRow(AppRow)

/** Read an App. With `lock`, keep the row locked until the transaction ends. */
export const findApp = (
	db: Database,
	namespace: string,
	cardUrl: string,
	lock: boolean = false,
) => {
	const query = db
		.select()
		.from(developerApps)
		.where(
			and(
				eq(developerApps.namespace, namespace),
				eq(developerApps.cardUrl, cardUrl),
			),
		)
	return stored(lock ? query.for("update") : query).pipe(
		Effect.flatMap((rows) =>
			Effect.transposeOption(Option.map(Arr.head(rows), decodeApp)),
		),
	)
}

export const getApp = (
	db: Database,
	namespace: string,
	cardUrl: string,
	lock: boolean = false,
) =>
	findApp(db, namespace, cardUrl, lock).pipe(
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.fail(Developers.DeveloperNotFound.make({})),
				onSome: Effect.succeed,
			}),
		),
	)

export { AppRow }
