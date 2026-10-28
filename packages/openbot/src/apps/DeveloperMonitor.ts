import {
	type PlatformError,
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	HashSet,
	Layer,
	Option,
	Schema,
} from "effect"
import type { SecretStorageError } from "../secrets/Secrets.ts"
import * as Models from "./DeveloperModels.ts"
import { Developers, Execution } from "@openbot-build/domain"
import { and, eq } from "drizzle-orm"
import {
	developerProofs,
	developerMembers,
	developerSubscriptions,
} from "../database/Schema.ts"
import { SqlClient } from "effect/sql"
import * as Db from "../database/Database.ts"
import { Store, transactionFailures, type Fence } from "../execution/Store.ts"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import { AppInspections } from "./AppInspections.ts"
import { issueKey, sameIssue } from "./DeveloperReports.ts"
import * as Rows from "./DeveloperRows.ts"
import * as DeveloperNotices from "./DeveloperNotices.ts"
import { DeveloperWatches, type Reference } from "./DeveloperWatches.ts"
import { IndexNamespace } from "./IndexNamespace.ts"

export const CheckResult = Schema.TaggedUnion({
	App: { report: Models.InspectionReport },
	Proof: {
		previous: Developers.Proof,
		evidence: Developers.ProofEvidence,
		report: Schema.NullOr(Models.InspectionReport),
	},
	Relinquished: {},
	Failed: { failure: Execution.Failure },
})
export type CheckResult = typeof CheckResult.Type

export interface Service {
	readonly prepare: (ref: Reference) => Effect.Effect<
		| { readonly kind: "App"; readonly id: string; readonly proof?: never }
		| {
				readonly id?: never
				readonly kind: "Proof"
				readonly proof: Rows.ProofRecord
		  },
		| Developers.DeveloperForbidden
		| Developers.DeveloperNotFound
		| Developers.StorageFailure
	>
	readonly inspect: (
		input:
			| { readonly kind: "App"; readonly id: string; readonly proof?: never }
			| {
					readonly id?: never
					readonly kind: "Proof"
					readonly proof: Rows.ProofRecord
			  },
	) => Effect.Effect<
		| {
				readonly _tag: "App"
				readonly report: Models.InspectionReport
				readonly previous?: never
				readonly evidence?: never
		  }
		| {
				readonly _tag: "Relinquished"
				readonly previous?: never
				readonly evidence?: never
				readonly report?: never
		  }
		| {
				readonly _tag: "Proof"
				readonly previous: Developers.Proof
				readonly evidence: Developers.ProofEvidence
				readonly report: Models.InspectionReport | null
		  },
		Developers.Failure
	>
	readonly complete: (
		fence: Fence,
		revision: number,
		result: CheckResult,
	) => Effect.Effect<
		undefined,
		| Execution.Conflict
		| Developers.DeveloperConflict
		| Developers.DeveloperForbidden
		| Developers.DeveloperInputInvalid
		| Developers.DeveloperNotFound
		| Developers.DeveloperRestricted
		| Developers.DeveloperUnavailable
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| PlatformError.PlatformError
		| Schema.SchemaError
		| SecretStorageError
		| Execution.StorageError
	>
}

export class DeveloperMonitor extends Context.Service<
	DeveloperMonitor,
	Service
>()("@openbot-build/openbot/apps/DeveloperMonitor") {}

const make = Effect.gen(function* () {
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const namespace = yield* IndexNamespace
	const access = yield* DeveloperAccess
	const inspections = yield* AppInspections
	const crypto = yield* Crypto.Crypto
	const store = yield* Store
	const watches = yield* DeveloperWatches
	const notices = yield* DeveloperNotices.make
	/** Every account that holds a proof or is a member of one. */
	const possibleOwners = Effect.gen(function* () {
		const proofs = yield* Rows.stored(
			db
				.selectDistinct({ owner: developerProofs.owner })
				.from(developerProofs)
				.where(eq(developerProofs.namespace, namespace)),
		)
		const members = yield* Rows.stored(
			db
				.selectDistinct({ owner: developerMembers.owner })
				.from(developerMembers)
				.where(eq(developerMembers.namespace, namespace)),
		)
		return HashSet.fromIterable(
			Arr.map([...proofs, ...members], (row) => row.owner),
		)
	})

	const prepare = Effect.fn("DeveloperMonitor.prepare")(function* (
		ref: Reference,
	) {
		return ref.kind === "App"
			? ({ kind: "App", id: ref.id } as const)
			: ({ kind: "Proof", proof: yield* access.readProof(ref.id) } as const)
	})
	const inspect = Effect.fn("DeveloperMonitor.inspect")(function* (
		input: Effect.Success<ReturnType<typeof prepare>>,
	) {
		if (input.kind === "App")
			return {
				_tag: "App",
				report: yield* inspections.inspect(input.id),
			} as const
		const current = input.proof
		if (current.value.status === "Relinquished")
			return { _tag: "Relinquished" } as const
		const evidence = yield* access.checkEvidence(
			current.value.scope,
			current.token,
		)
		const report =
			evidence._tag === "Matched"
				? yield* access.inspectScope(current.value.scope)
				: null
		return { _tag: "Proof", previous: current.value, evidence, report } as const
	})
	const complete = Effect.fn("DeveloperMonitor.complete")(function* (
		fence: Fence,
		revision: number,
		result: CheckResult,
	) {
		const current = yield* watches.load(fence)
		if (result._tag === "Relinquished") {
			yield* store.commit(fence, { status: "completed" }, Effect.void)
			return
		}
		return yield* sql
			.withTransaction(
				Effect.gen(function* () {
					// Domain rows come before watch and execution rows in every transaction.
					if (current.ref.kind === "App")
						yield* Rows.getApp(db, namespace, current.ref.id, true)
					else yield* access.readProof(current.ref.id, true)
					return yield* watches.complete(
						fence,
						revision,
						Effect.gen(function* () {
							const now = yield* Clock.currentTimeMillis
							if (result._tag === "Failed")
								return { nextCheckAt: now + 60000, value: undefined }
							if (current.ref.kind === "Proof") {
								if (result._tag !== "Proof")
									return yield* Effect.die("A proof check has an App result.")
								const value = yield* access.applyEvidence(
									result.previous,
									result.evidence,
									result.report,
								)
								return {
									nextCheckAt: value.nextVerificationAt,
									value: undefined,
								}
							}
							if (result._tag !== "App")
								return yield* Effect.die("An App check has a proof result.")
							const cardUrl = current.ref.id
							const report = result.report
							const app = yield* Rows.getApp(db, namespace, cardUrl, true)
							const interested = yield* Effect.filter(
								yield* possibleOwners,
								(owner) => access.allows(owner, cardUrl),
							)
							const disabled = yield* Rows.stored(
								db
									.select({ owner: developerSubscriptions.owner })
									.from(developerSubscriptions)
									.where(
										and(
											eq(developerSubscriptions.namespace, namespace),
											eq(developerSubscriptions.cardUrl, cardUrl),
											eq(developerSubscriptions.enabled, false),
										),
									),
							)
							const issues = Arr.filter(
								report.issues,
								(issue) => issue.severity === "blocking",
							)
							const revision = app.monitorRevision + 1
							const changes = [
								...Arr.map(
									Arr.differenceWith(sameIssue)(issues, app.monitorIssues),
									(issue) => ({ issue, kind: "IssueAppeared" as const }),
								),
								...Arr.map(
									Arr.differenceWith(sameIssue)(app.monitorIssues, issues),
									(issue) => ({ issue, kind: "IssueResolved" as const }),
								),
							]
							const reportId = yield* crypto.randomUUIDv7()
							yield* Rows.saveReport(db, namespace, null, {
								id: reportId,
								cardUrl,
								createdBy: Rows.monitorOwner,
								report,
							})
							for (const owner of interested) {
								if (Arr.some(disabled, (row) => row.owner === owner)) continue
								for (const change of changes)
									yield* notices.emit(
										owner,
										[cardUrl, revision, issueKey(change.issue), change.kind],
										{
											cardUrl,
											kind: change.kind,
											issue: change.issue,
											reason: null,
											reportId,
											createdAt: report.checkedAt,
										},
									)
							}
							const observed = Arr.findFirst(
								report.apps,
								(value) => value.candidate.cardUrl === cardUrl,
							)
							yield* Rows.putApp(db, namespace, {
								...app,
								candidate: Option.match(observed, {
									onNone: () => app.candidate,
									onSome: (value) => ({
										...value.candidate,
										sources: app.candidate.sources,
									}),
								}),
								nextCheckAt: now + 3600000,
								monitorRevision: revision,
								monitorIssues: issues,
							})
							return { nextCheckAt: now + 3600000, value: undefined }
						}),
					)
				}),
			)
			.pipe(transactionFailures)
	})
	return DeveloperMonitor.of({ prepare, inspect, complete })
})

export const layer = Layer.effect(DeveloperMonitor, make)
