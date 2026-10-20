import { randomUUID } from "node:crypto"
import { DeveloperApi as Api } from "@openbot-build/platform-api"
import { Context, Effect, Layer } from "effect"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import { DeveloperRepository } from "./DeveloperRepository.ts"
import { AppInspections } from "./AppInspections.ts"

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
>()("@openbot-build/platform/apps/DeveloperReports") {}
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
	DeveloperAccess | DeveloperRepository | AppInspections
> = Effect.gen(function* () {
	const access = yield* DeveloperAccess
	const records = yield* DeveloperRepository
	const inspections = yield* AppInspections
	const get = Effect.fn("DeveloperReports.get")(function* (
		owner: string,
		id: string,
	) {
		const record = yield* records.reports.get(id)
		yield* access.authorize(owner, record.value.cardUrl)
		return record.value
	})
	return DeveloperReports.of({
		get,
		personal: (owner, before) =>
			Effect.gen(function* () {
				const all = (yield* records.reports.list({ owner }))
					.map((record) => record.value)
					.toSorted(
						(a, b) =>
							b.report.checkedAt - a.report.checkedAt ||
							b.id.localeCompare(a.id),
					)
				const start =
					before === undefined
						? 0
						: all.findIndex((report) => report.id === before) + 1
				if (before !== undefined && start === 0)
					return yield* Api.DeveloperInputInvalid.make({
						message:
							"The report cursor is no longer available. Reload your records.",
					})
				return all.slice(start, start + 50).map((report) => ({
					id: report.id,
					cardUrl: report.cardUrl,
					checkedAt: report.report.checkedAt,
				}))
			}),
		save: (owner, cardUrl) =>
			Effect.gen(function* () {
				yield* access.authorize(owner, cardUrl, true)
				const report = yield* inspections.inspect(cardUrl)
				return yield* records.transaction(
					"monitor:" + cardUrl,
					Effect.gen(function* () {
						yield* access.authorize(owner, cardUrl, true)
						const value: Api.SavedReport = {
							id: yield* Effect.sync(randomUUID),
							cardUrl,
							createdBy: owner,
							report,
						}
						yield* records.reports.put(value.id, owner, cardUrl, {
							owner,
							value,
						})
						const observed = report.apps.find(
							(app) => app.candidate.cardUrl === cardUrl,
						)
						if (observed !== undefined) {
							const app = yield* records.apps.get(cardUrl)
							yield* records.apps.put(cardUrl, "", cardUrl, {
								...app,
								candidate: {
									...observed.candidate,
									sources: app.candidate.sources,
								},
							})
						}

						return value
					}),
				)
			}),
		list: (owner, cardUrl, before) =>
			Effect.gen(function* () {
				yield* access.authorize(owner, cardUrl)
				const all = (yield* records.reports.list({ scope: cardUrl }))
					.map((record) => record.value)
					.toSorted(
						(a, b) =>
							b.report.checkedAt - a.report.checkedAt ||
							b.id.localeCompare(a.id),
					)
				const start =
					before === undefined
						? 0
						: all.findIndex((report) => report.id === before) + 1
				if (before !== undefined && start === 0)
					return yield* Api.DeveloperInputInvalid.make({
						message:
							"The report cursor is no longer available. Reload the history.",
					})
				return all.slice(start, start + 50)
			}),
		compare: (owner, id, other) =>
			Effect.gen(function* () {
				const before = yield* get(owner, id)
				const after = yield* get(owner, other)
				if (before.cardUrl !== after.cardUrl)
					return yield* Api.DeveloperInputInvalid.make({
						message: "Choose two reports for the same Card URL.",
					})
				return compare(before.report, after.report)
			}),
		remove: (owner, id) =>
			Effect.gen(function* () {
				const record = yield* records.reports.get(id)
				if (record.owner !== owner) return yield* Api.DeveloperNotFound.make({})
				yield* records.reports.remove(id)
			}),
	})
})
export const layer = Layer.effect(DeveloperReports, make)
