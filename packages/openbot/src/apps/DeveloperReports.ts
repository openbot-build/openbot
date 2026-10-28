import * as Models from "./DeveloperModels.ts"
import { Developers } from "@openbot-build/domain"

import { PgClient } from "@effect/sql-pg"
import { and, desc, eq, lt, or, type SQL } from "drizzle-orm"
import {
	Array as Arr,
	Context,
	Crypto,
	Effect,
	Equivalence,
	Layer,
	Option,
	Schema,
} from "effect"
import { developerReports } from "../database/Schema.ts"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import * as Rows from "./DeveloperRows.ts"
import { AppInspections } from "./AppInspections.ts"
import { IndexNamespace } from "./IndexNamespace.ts"
import * as Db from "../database/Database.ts"

export class DeveloperReports extends Context.Service<
	DeveloperReports,
	{
		readonly save: (
			owner: string,
			cardUrl: string,
		) => Effect.Effect<Models.SavedReport, Developers.Failure>
		readonly list: (
			owner: string,
			cardUrl: string,
			before?: string,
		) => Effect.Effect<ReadonlyArray<Models.SavedReport>, Developers.Failure>
		readonly get: (
			owner: string,
			id: string,
		) => Effect.Effect<Models.SavedReport, Developers.Failure>
		readonly compare: (
			owner: string,
			id: string,
			other: string,
		) => Effect.Effect<Developers.ReportDiff, Developers.Failure>
		readonly remove: (
			owner: string,
			id: string,
		) => Effect.Effect<void, Developers.Failure>
		readonly personal: (
			owner: string,
			before?: string,
		) => Effect.Effect<
			ReadonlyArray<Developers.PersonalReport>,
			Developers.Failure
		>
	}
>()("@openbot-build/openbot/apps/DeveloperReports") {}
export const issueKey = (issue: Developers.Issue): string =>
	JSON.stringify([
		issue.code,
		issue.stage,
		issue.source,
		issue.fieldPath ?? null,
	])
/** Two issues are the same issue when the fields of `issueKey` are the same. */
export const sameIssue: Equivalence.Equivalence<Developers.Issue> =
	Equivalence.mapInput(
		Equivalence.Tuple([
			Equivalence.String,
			Equivalence.String,
			Equivalence.String,
			Equivalence.strictEqual<string | null>(),
		]),
		(issue: Developers.Issue) =>
			[issue.code, issue.stage, issue.source, issue.fieldPath ?? null] as const,
	)
const compare = (
	before: Models.InspectionReport,
	after: Models.InspectionReport,
): Developers.ReportDiff => ({
	introduced: Arr.differenceWith(sameIssue)(after.issues, before.issues),
	resolved: Arr.differenceWith(sameIssue)(before.issues, after.issues),
	persisting: Arr.intersectionWith(sameIssue)(after.issues, before.issues),
})
const isUuid = Schema.is(Schema.String.check(Schema.isUUID()))

export const make: Effect.Effect<
	typeof DeveloperReports.Service,
	never,
	DeveloperAccess | PgClient.PgClient | AppInspections | Crypto.Crypto
> = Effect.gen(function* () {
	const access = yield* DeveloperAccess
	const db = yield* Db.make
	const inTransaction = Rows.transaction(yield* PgClient.PgClient)
	const namespace = yield* IndexNamespace
	const inspections = yield* AppInspections
	const crypto = yield* Crypto.Crypto
	const reportWhere = (id: string) =>
		and(eq(developerReports.namespace, namespace), eq(developerReports.id, id))
	const read = Effect.fn("DeveloperReports.read")(function* (id: string) {
		if (!isUuid(id)) return yield* Developers.DeveloperNotFound.make({})
		const row = (yield* Rows.stored(
			db.select().from(developerReports).where(reportWhere(id)),
		))[0]
		if (row === undefined) return yield* Developers.DeveloperNotFound.make({})
		return row
	})
	const get = Effect.fn("DeveloperReports.get")(function* (
		owner: string,
		id: string,
	) {
		const value = yield* Rows.decodeReport(yield* read(id))
		yield* access.authorize(owner, value.cardUrl)
		return value
	})
	/**
	 * One page of reports, newest first. `before` is the ID of the last report
	 * of the previous page. It must be one of the reports that `filter` selects.
	 */
	const page = Effect.fn("DeveloperReports.page")(function* (
		filter: SQL | undefined,
		before: string | undefined,
		message: string,
	) {
		let after: SQL | undefined
		if (before !== undefined) {
			if (!isUuid(before))
				return yield* Developers.DeveloperInputInvalid.make({ message })
			const cursor = (yield* Rows.stored(
				db
					.select({
						checkedAt: developerReports.checkedAt,
						id: developerReports.id,
					})
					.from(developerReports)
					.where(and(filter, eq(developerReports.id, before))),
			))[0]
			if (cursor === undefined)
				return yield* Developers.DeveloperInputInvalid.make({ message })
			after = or(
				lt(developerReports.checkedAt, cursor.checkedAt),
				and(
					eq(developerReports.checkedAt, cursor.checkedAt),
					lt(developerReports.id, cursor.id),
				),
			)
		}
		return yield* Rows.stored(
			db
				.select()
				.from(developerReports)
				.where(and(filter, after))
				.orderBy(desc(developerReports.checkedAt), desc(developerReports.id))
				.limit(50),
		)
	})
	return DeveloperReports.of({
		get,
		personal: Effect.fn("DeveloperReports.personal")(function* (owner, before) {
			const rows = yield* page(
				and(
					eq(developerReports.namespace, namespace),
					eq(developerReports.owner, owner),
				),
				before,
				"The report cursor is no longer available. Reload your records.",
			)
			return Arr.map(rows, (row) => ({
				id: row.id,
				cardUrl: row.cardUrl,
				checkedAt: row.checkedAt,
			}))
		}),
		save: Effect.fn("DeveloperReports.save")(function* (owner, cardUrl) {
			yield* access.authorize(owner, cardUrl, true)
			const report = yield* inspections.inspect(cardUrl)
			return yield* inTransaction(
				Effect.gen(function* () {
					// Lock the App first, so the monitor does not change it at the same time.
					const app = yield* Rows.getApp(db, namespace, cardUrl, true)
					yield* access.authorize(owner, cardUrl, true)
					const value: Models.SavedReport = {
						id: yield* crypto.randomUUIDv7().pipe(Effect.orDie),
						cardUrl,
						createdBy: owner,
						report,
					}
					yield* Rows.saveReport(db, namespace, owner, value)
					const observed = Arr.findFirst(
						report.apps,
						(app) => app.candidate.cardUrl === cardUrl,
					)
					if (Option.isSome(observed))
						yield* Rows.putApp(db, namespace, {
							...app,
							candidate: {
								...observed.value.candidate,
								sources: app.candidate.sources,
							},
						})
					return value
				}),
			)
		}),
		list: Effect.fn("DeveloperReports.list")(
			function* (owner, cardUrl, before) {
				yield* access.authorize(owner, cardUrl)
				const rows = yield* page(
					and(
						eq(developerReports.namespace, namespace),
						eq(developerReports.cardUrl, cardUrl),
					),
					before,
					"The report cursor is no longer available. Reload the history.",
				)
				return yield* Effect.forEach(rows, Rows.decodeReport)
			},
		),
		compare: Effect.fn("DeveloperReports.compare")(
			function* (owner, id, other) {
				const before = yield* get(owner, id)
				const after = yield* get(owner, other)
				if (before.cardUrl !== after.cardUrl)
					return yield* Developers.DeveloperInputInvalid.make({
						message: "Choose two reports for the same Card URL.",
					})
				return compare(before.report, after.report)
			},
		),
		remove: Effect.fn("DeveloperReports.remove")(function* (owner, id) {
			const row = yield* read(id)
			if (row.owner !== owner)
				return yield* Developers.DeveloperNotFound.make({})
			yield* Rows.stored(db.delete(developerReports).where(reportWhere(id)))
		}),
	})
})
export const layer = Layer.effect(DeveloperReports, make)
