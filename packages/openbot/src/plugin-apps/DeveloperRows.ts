import * as Models from "./DeveloperModels.ts"
import type { PgClient } from "@effect/sql-pg"
import { Developers } from "@openbot-build/domain"
import { and, eq } from "drizzle-orm"
import { Array as Arr, Effect, Option, Schema } from "effect"
import {
	developerApps,
	developerNotices,
	developerReports,
	developerTestFlows,
	developerTests,
} from "@openbot-build/server-database/Schema"
import { transactionFailures } from "../server-execution/execution/Store.ts"
import {
	type Database,
	stored,
	Json,
	decodeRow,
	ProofRow,
	AppRow,
} from "../apps-contract/apps/DeveloperRows.ts"
export {
	stored,
	Json,
	decodeRow,
	ProofRow,
	decodeProof,
	decodeApp,
	findApp,
	getApp,
} from "../apps-contract/apps/DeveloperRows.ts"
export type {
	Database,
	ProofRecord,
} from "../apps-contract/apps/DeveloperRows.ts"

/** Drizzle queries join this transaction. A nested call uses a savepoint. */
export const transaction =
	(sql: PgClient.PgClient) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		sql.withTransaction(effect).pipe(transactionFailures)

export const encodeRow =
	<S extends Schema.Top>(schema: S) =>
	(value: S["Type"]) =>
		Schema.encodeEffect(schema)(value)

/** The account of an owner key, which is `[organizationId, userId]` as JSON. */
export const identityOf = (owner: string) =>
	decodeRow(
		Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
	)(owner).pipe(
		Effect.map(([organizationId, userId]) => ({ organizationId, userId })),
	)

export const ClaimRow = Schema.Struct({
	...Developers.Challenge.fields,
	scope: Json(Developers.ManagementScope),
})

export const decodeClaim = decodeRow(ClaimRow)

export const encodeClaim = encodeRow(ClaimRow)

export const encodeProof = encodeRow(ProofRow)

/** An App that a proof covers, with the state of its monitor check. */
export type AppRecord = typeof AppRow.Type

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
	...Developers.Notice.fields,
	issue: Schema.NullOr(Json(Developers.Issue)),
})

export const decodeNotice = decodeRow(NoticeRow)

/** Save a notice once. A notice with the same ID stays as it is. */
export const postNotice = Effect.fn("DeveloperRows.postNotice")(function* (
	db: Database,
	namespace: string,
	owner: string,
	notice: Developers.Notice,
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
	value: Json(Models.ConnectionTest),
	resourceMetadataUrl: Schema.NullOr(Schema.String),
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
				onNone: () => Effect.fail(Developers.DeveloperNotFound.make({})),
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
	actor: Schema.optionalKey(Schema.NullOr(Schema.String)),
	owner: Schema.String,
	testId: Schema.String,
	value: Json(Developers.TestAuthorization),
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
	if (row === undefined) return yield* Developers.DeveloperNotFound.make({})
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
	decodeRow(Json(Models.InspectionReport))(row.report).pipe(
		Effect.map((report): Models.SavedReport => ({
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
	value: Models.SavedReport,
) {
	const report = yield* encodeRow(Json(Models.InspectionReport))(value.report)
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
