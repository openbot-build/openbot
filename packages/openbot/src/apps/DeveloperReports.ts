import { randomUUID } from "node:crypto"
import { DeveloperApi as Api } from "@openbot-build/api"
import { PgClient } from "@effect/sql-pg"
import { and, desc, eq, lt, or, type SQL } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { Context, Effect, Layer } from "effect"
import { developerReports } from "../database/Schema.ts"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import * as Rows from "./DeveloperRows.ts"
import { AppInspections } from "./AppInspections.ts"
import { IndexNamespace } from "./IndexNamespace.ts"

export class DeveloperReports extends Context.Service<
	DeveloperReports,
	{
		readonly save: (
			owner: string,
			cardUrl: string,
		) => Effect.Effect<Api.SavedReport, Api.Failure>
		readonly list: (
			owner: string,
			cardUrl: string,
			before?: string,
		) => Effect.Effect<ReadonlyArray<Api.SavedReport>, Api.Failure>
		readonly get: (
			owner: string,
			id: string,
		) => Effect.Effect<Api.SavedReport, Api.Failure>
		readonly compare: (
			owner: string,
			id: string,
			other: string,
		) => Effect.Effect<Api.ReportDiff, Api.Failure>
		readonly remove: (
			owner: string,
			id: string,
		) => Effect.Effect<void, Api.Failure>
		readonly personal: (
			owner: string,
			before?: string,
		) => Effect.Effect<ReadonlyArray<Api.PersonalReport>, Api.Failure>
	}
>()("@openbot-build/openbot/apps/DeveloperReports") {}
export const issueKey = (issue: Api.Issue): string =>
	JSON.stringify([
		issue.code,
		issue.stage,
		issue.source,
		issue.fieldPath ?? null,
	])
const compare = (
	before: Api.InspectionReport,
	after: Api.InspectionReport,
): Api.ReportDiff => ({
	introduced: after.issues.filter(
		(issue) =>
			!before.issues.some((previous) => issueKey(issue) === issueKey(previous)),
	),
	resolved: before.issues.filter(
		(issue) => !after.issues.some((next) => issueKey(issue) === issueKey(next)),
	),
	persisting: after.issues.filter((issue) =>
		before.issues.some((previous) => issueKey(issue) === issueKey(previous)),
	),
})
export const make: Effect.Effect<
	typeof DeveloperReports.Service,
	never,
	DeveloperAccess | PgClient.PgClient | AppInspections
> = Effect.gen(function* () {
	const access = yield* DeveloperAccess
	const db = yield* makeWithDefaults()
	const inTransaction = Rows.transaction(yield* PgClient.PgClient)
	const namespace = yield* IndexNamespace
	const inspections = yield* AppInspections
	const reportWhere = (id: string) =>
		and(eq(developerReports.namespace, namespace), eq(developerReports.id, id))
	const read = Effect.fn("DeveloperReports.read")(function* (id: string) {
		const row = (yield* Rows.stored(
			db.select().from(developerReports).where(reportWhere(id)),
		))[0]
		if (row === undefined) return yield* Api.DeveloperNotFound.make({})
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
				return yield* Api.DeveloperInputInvalid.make({ message })
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
			return rows.map((row) => ({
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
					const value: Api.SavedReport = {
						id: yield* Effect.sync(randomUUID),
						cardUrl,
						createdBy: owner,
						report,
					}
					yield* Rows.saveReport(db, namespace, owner, value)
					const observed = report.apps.find(
						(app) => app.candidate.cardUrl === cardUrl,
					)
					if (observed !== undefined)
						yield* Rows.putApp(db, namespace, {
							...app,
							candidate: {
								...observed.candidate,
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
					return yield* Api.DeveloperInputInvalid.make({
						message: "Choose two reports for the same Card URL.",
					})
				return compare(before.report, after.report)
			},
		),
		remove: Effect.fn("DeveloperReports.remove")(function* (owner, id) {
			const row = yield* read(id)
			if (row.owner !== owner) return yield* Api.DeveloperNotFound.make({})
			yield* Rows.stored(db.delete(developerReports).where(reportWhere(id)))
		}),
	})
})
export const layer = Layer.effect(DeveloperReports, make)
