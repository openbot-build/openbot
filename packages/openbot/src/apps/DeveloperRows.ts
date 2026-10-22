// These are plain query functions that take the database first. A pipeable form does not help here.
// @effect-diagnostics missingPipeableSignature:off
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

/**
 * The Developer Center tables in Postgres: the codecs between rows and API
 * values, and the queries that more than one Developer module uses.
 * Every table has a `namespace` column, so the development host keeps its own rows.
 */
export type Database = Db.Database

export const unavailable = () => Api.DeveloperUnavailable.make({})
/** Every storage failure becomes one error. */
export const stored = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Api.DeveloperUnavailable, R> =>
	effect.pipe(Effect.mapError(unavailable))
/**
 * Run the effect in one database transaction. Drizzle queries on the `db` of
 * `Db.make` join this transaction. A nested call becomes a savepoint.
 */
export const transaction =
	(sql: PgClient.PgClient) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		sql
			.withTransaction(effect)
			.pipe(Effect.catchTag("SqlError", () => Effect.fail(unavailable())))

/** A column that holds a value as JSON text. */
export const Json = <S extends Schema.Top>(schema: S) =>
	Schema.fromJsonString(Schema.toCodecJson(schema))
const decodeRow =
	<S extends Schema.Top>(schema: S) =>
	(row: unknown) =>
		Schema.decodeUnknownEffect(schema)(row).pipe(Effect.mapError(unavailable))
const encodeRow =
	<S extends Schema.Top>(schema: S) =>
	(value: S["Type"]) =>
		Schema.encodeEffect(schema)(value).pipe(Effect.mapError(unavailable))

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
export const getProof = Effect.fn("DeveloperRows.getProof")(function* (
	db: Database,
	namespace: string,
	id: string,
) {
	const row = (yield* stored(
		db
			.select()
			.from(developerProofs)
			.where(
				and(
					eq(developerProofs.namespace, namespace),
					eq(developerProofs.id, id),
				),
			),
	))[0]
	if (row === undefined) return yield* Api.DeveloperNotFound.make({})
	return yield* decodeProof(row)
})

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
const appWhere = (namespace: string, cardUrl: string) =>
	and(
		eq(developerApps.namespace, namespace),
		eq(developerApps.cardUrl, cardUrl),
	)
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
		.where(appWhere(namespace, cardUrl))
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
const flowWhere = (namespace: string, flowId: string) =>
	and(
		eq(developerTestFlows.namespace, namespace),
		eq(developerTestFlows.flowId, flowId),
	)
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
		.where(flowWhere(namespace, flowId))
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
