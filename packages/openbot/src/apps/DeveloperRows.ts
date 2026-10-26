import type { PgClient } from "@effect/sql-pg"
import { DeveloperApi as Api } from "@openbot-build/api"
import { Discovery } from "@openbot-build/protocol"
import { and, eq } from "drizzle-orm"
import { Array as Arr, Effect, Option, Schema } from "effect"
import {
	developerApps,
	developerNotices,
	developerProofs,
	developerReports,
	developerTestFlows,
	developerTests,
} from "../database/Schema.ts"
import * as Db from "../database/Database.ts"
import * as Failures from "../app/Failures.ts"

/**
 * The Developer Center tables in Postgres: the codecs between rows and API
 * values, and the queries that more than one Developer module uses.
 * Every table has a `namespace` column, so the development host keeps its own rows.
 */
export type Database = Db.Database

/** Every storage failure becomes one error. The log keeps the storage failure. */
export const stored = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Api.DeveloperUnavailable, R> =>
	effect.pipe(
		Failures.replace("A Developer Center query failed.", () =>
			Api.DeveloperUnavailable.make({}),
		),
	)
/**
 * Run the effect in one database transaction. Drizzle queries on the `db` of
 * `Db.make` join this transaction. A nested call becomes a savepoint.
 */
export const transaction =
	(sql: PgClient.PgClient) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		sql
			.withTransaction(effect)
			.pipe(
				Effect.catchTag("SqlError", (error) =>
					Effect.fail(error).pipe(
						Failures.replace("A Developer Center transaction failed.", () =>
							Api.DeveloperUnavailable.make({}),
						),
					),
				),
			)

/** A column that holds a value as JSON text. */
export const Json = <S extends Schema.Top>(schema: S) =>
	Schema.fromJsonString(Schema.toCodecJson(schema))
/** Read a stored value. A value that does not match the schema means the storage is broken. */
export const decodeRow =
	<S extends Schema.Top>(schema: S) =>
	(row: unknown) =>
		Schema.decodeUnknownEffect(schema)(row).pipe(
			Failures.replace("A stored Developer Center value is not valid.", () =>
				Api.DeveloperUnavailable.make({}),
			),
		)
export const encodeRow =
	<S extends Schema.Top>(schema: S) =>
	(value: S["Type"]) =>
		Schema.encodeEffect(schema)(value).pipe(
			Failures.replace("A Developer Center value could not be stored.", () =>
				Api.DeveloperUnavailable.make({}),
			),
		)

/** The account of an owner key, which is `[organizationId, userId]` as JSON. */
export const identityOf = (owner: string) =>
	decodeRow(
		Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
	)(owner).pipe(
		Effect.map(([organizationId, userId]) => ({ organizationId, userId })),
	)

export const ClaimRow = Schema.Struct({
	...Api.Challenge.fields,
	scope: Json(Api.ManagementScope),
})
export const decodeClaim = decodeRow(ClaimRow)
export const encodeClaim = encodeRow(ClaimRow)

export const ProofRow = Schema.Struct({
	...Api.Proof.fields,
	scope: Json(Api.ManagementScope),
})
export interface ProofRecord {
	readonly owner: string
	readonly token: string
	readonly value: Api.Proof
}
export const decodeProof = (row: typeof developerProofs.$inferSelect) =>
	decodeRow(ProofRow)(row).pipe(
		Effect.map((value): ProofRecord => ({
			owner: row.owner,
			token: row.token,
			value,
		})),
	)
export const encodeProof = encodeRow(ProofRow)

const AppRow = Schema.Struct({
	cardUrl: Schema.String,
	candidate: Json(Discovery.Candidate),
	nextCheckAt: Schema.Finite,
	leaseUntil: Schema.Finite,
	monitorToken: Schema.NullOr(Schema.String),
	monitorRevision: Schema.Natural,
	monitorIssues: Json(Schema.Array(Api.Issue)),
})
/** An App that a proof covers, with the state of its monitor check. */
export type AppRecord = typeof AppRow.Type
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
				onNone: () => Effect.fail(Api.DeveloperNotFound.make({})),
				onSome: Effect.succeed,
			}),
		),
	)
export const putApp = Effect.fn("DeveloperRows.putApp")(function* (
	db: Database,
	namespace: string,
	app: AppRecord,
) {
	const row = { namespace, ...(yield* encodeRow(AppRow)(app)) }
	yield* stored(
		db
			.insert(developerApps)
			.values(row)
			.onConflictDoUpdate({
				target: [developerApps.namespace, developerApps.cardUrl],
				set: row,
			}),
	)
})

const NoticeRow = Schema.Struct({
	...Api.Notice.fields,
	issue: Schema.NullOr(Json(Api.Issue)),
})
export const decodeNotice = decodeRow(NoticeRow)
/** Save a notice once. A notice with the same ID stays as it is. */
export const postNotice = Effect.fn("DeveloperRows.postNotice")(function* (
	db: Database,
	namespace: string,
	owner: string,
	notice: Api.Notice,
) {
	const row = yield* encodeRow(NoticeRow)(notice)
	yield* stored(
		db
			.insert(developerNotices)
			.values({ namespace, owner, ...row })
			.onConflictDoNothing(),
	)
})

const TestRow = Schema.Struct({
	owner: Schema.String,
	value: Json(Api.ConnectionTest),
	resourceMetadataUrl: Schema.NullOr(Schema.String),
	cleanupToken: Schema.NullOr(Schema.String),
	cleanupLeaseUntil: Schema.Finite,
})
/** A connection test with the private fields that only the server reads. */
export type TestRecord = typeof TestRow.Type
const testWhere = (namespace: string, id: string) =>
	and(eq(developerTests.namespace, namespace), eq(developerTests.id, id))
export const decodeTest = decodeRow(TestRow)
/** Read a test. With `lock`, keep the row locked until the transaction ends. */
export const findTest = (
	db: Database,
	namespace: string,
	id: string,
	lock: boolean = false,
) => {
	const query = db.select().from(developerTests).where(testWhere(namespace, id))
	return stored(lock ? query.for("update") : query).pipe(
		Effect.flatMap((rows) =>
			Effect.transposeOption(Option.map(Arr.head(rows), decodeTest)),
		),
	)
}
export const getTest = (
	db: Database,
	namespace: string,
	id: string,
	lock: boolean = false,
) =>
	findTest(db, namespace, id, lock).pipe(
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.fail(Api.DeveloperNotFound.make({})),
				onSome: Effect.succeed,
			}),
		),
	)
/** Save a test. The query columns are copied from its value here, and only here. */
export const putTest = Effect.fn("DeveloperRows.putTest")(function* (
	db: Database,
	namespace: string,
	record: TestRecord,
) {
	const encoded = yield* encodeRow(TestRow)(record)
	const row = {
		...encoded,
		cardUrl: record.value.cardUrl,
		status: record.value.status,
		cleanup: record.value.cleanup,
		expiresAt: record.value.expiresAt,
	}
	yield* stored(
		db
			.insert(developerTests)
			.values({ namespace, id: record.value.id, ...row })
			.onConflictDoUpdate({
				target: [developerTests.namespace, developerTests.id],
				set: row,
			}),
	)
})

const FlowRow = Schema.Struct({
	owner: Schema.String,
	testId: Schema.String,
	value: Json(Api.TestAuthorization),
	body: Schema.NullOr(Schema.String),
	callback: Schema.NullOr(Schema.String),
	consumed: Schema.Boolean,
})
/**
 * An authorization flow of a connection test. `body` is the sealed flow and
 * `callback` the sealed callback. A used flow has neither.
 */
export type FlowRecord = typeof FlowRow.Type
export const decodeFlow = decodeRow(FlowRow)
/** Read a flow. With `lock`, keep the row locked until the transaction ends. */
export const getFlow = Effect.fn("DeveloperRows.getFlow")(function* (
	db: Database,
	namespace: string,
	flowId: string,
	lock: boolean = false,
) {
	const query = db
		.select()
		.from(developerTestFlows)
		.where(
			and(
				eq(developerTestFlows.namespace, namespace),
				eq(developerTestFlows.flowId, flowId),
			),
		)
	const row = (yield* stored(lock ? query.for("update") : query))[0]
	if (row === undefined) return yield* Api.DeveloperNotFound.make({})
	return yield* decodeFlow(row)
})
export const putFlow = Effect.fn("DeveloperRows.putFlow")(function* (
	db: Database,
	namespace: string,
	record: FlowRecord,
) {
	const encoded = yield* encodeRow(FlowRow)(record)
	const row = {
		...encoded,
		status: record.value.status,
		expiresAt: record.value.expiresAt,
	}
	yield* stored(
		db
			.insert(developerTestFlows)
			.values({ namespace, flowId: record.value.flowId, ...row })
			.onConflictDoUpdate({
				target: [developerTestFlows.namespace, developerTestFlows.flowId],
				set: row,
			}),
	)
})

/** The owner of a report that the monitor saved. */
export const monitorOwner = "monitor"
export const decodeReport = (row: typeof developerReports.$inferSelect) =>
	decodeRow(Json(Api.InspectionReport))(row.report).pipe(
		Effect.map((report): Api.SavedReport => ({
			id: row.id,
			cardUrl: row.cardUrl,
			createdBy: row.owner ?? monitorOwner,
			report,
		})),
	)
/** Save a report. A monitor report has no owner. */
export const saveReport = Effect.fn("DeveloperRows.saveReport")(function* (
	db: Database,
	namespace: string,
	owner: string | null,
	value: Api.SavedReport,
) {
	const report = yield* encodeRow(Json(Api.InspectionReport))(value.report)
	yield* stored(
		db.insert(developerReports).values({
			namespace,
			id: value.id,
			owner,
			cardUrl: value.cardUrl,
			checkedAt: value.report.checkedAt,
			report,
		}),
	)
})
