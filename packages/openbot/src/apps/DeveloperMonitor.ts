import { createHash, randomUUID } from "node:crypto"
import { DeveloperApi as Api } from "@openbot-build/api"
import { PgClient } from "@effect/sql-pg"
import { and, eq, lte, ne } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import {
	Clock,
	Context,
	Effect,
	HashSet,
	Layer,
	Option,
	Schedule,
} from "effect"
import {
	developerApps,
	developerMembers,
	developerProofs,
	developerSubscriptions,
} from "../database/Schema.ts"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import { AppInspections } from "./AppInspections.ts"
import { issueKey } from "./DeveloperReports.ts"
import * as Rows from "./DeveloperRows.ts"
import { IndexNamespace } from "./IndexNamespace.ts"

export class DeveloperMonitor extends Context.Service<
	DeveloperMonitor,
	{ readonly run: Effect.Effect<void, Api.Failure> }
>()("@openbot-build/openbot/apps/DeveloperMonitor") {}

export const make: Effect.Effect<
	typeof DeveloperMonitor.Service,
	never,
	PgClient.PgClient | DeveloperAccess | AppInspections
> = Effect.gen(function* () {
	const db = yield* makeWithDefaults()
	const inTransaction = Rows.transaction(yield* PgClient.PgClient)
	const namespace = yield* IndexNamespace
	const access = yield* DeveloperAccess
	const inspections = yield* AppInspections
	/** Post a notice once. The same owner and identity always give the same notice ID. */
	const emit = (
		owner: string,
		identity: ReadonlyArray<string | number>,
		value: Omit<Api.Notice, "id" | "readAt">,
	) =>
		Rows.postNotice(db, namespace, owner, {
			...value,
			id: createHash("sha256")
				.update(JSON.stringify([owner, ...identity]))
				.digest("hex"),
			readAt: null,
		})
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
		return HashSet.fromIterable([...proofs, ...members].map((row) => row.owner))
	})
	/** Take the App for one check, unless another worker holds it. */
	const claim = (cardUrl: string, now: number) =>
		inTransaction(
			Effect.gen(function* () {
				const due = yield* Rows.stored(
					db
						.select({ cardUrl: developerApps.cardUrl })
						.from(developerApps)
						.where(
							and(
								eq(developerApps.namespace, namespace),
								eq(developerApps.cardUrl, cardUrl),
								lte(developerApps.nextCheckAt, now),
								lte(developerApps.leaseUntil, now),
							),
						)
						.for("update", { skipLocked: true }),
				)
				if (due.length === 0) return Option.none<string>()
				const token = yield* Effect.sync(randomUUID)
				yield* Rows.stored(
					db
						.update(developerApps)
						.set({ leaseUntil: now + 300000, monitorToken: token })
						.where(
							and(
								eq(developerApps.namespace, namespace),
								eq(developerApps.cardUrl, cardUrl),
							),
						),
				)
				return Option.some(token)
			}),
		)
	return DeveloperMonitor.of({
		run: Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const dueProofs = yield* Rows.stored(
				db
					.select()
					.from(developerProofs)
					.where(
						and(
							eq(developerProofs.namespace, namespace),
							ne(developerProofs.status, "Relinquished"),
							lte(developerProofs.nextVerificationAt, now),
						),
					),
			)
			for (const row of dueProofs) {
				const proof = yield* Rows.decodeProof(row)
				const next = yield* access.recheck(proof.value.id)
				if (next.status === proof.value.status) continue
				const members = yield* Rows.stored(
					db
						.select({ owner: developerMembers.owner })
						.from(developerMembers)
						.where(
							and(
								eq(developerMembers.namespace, namespace),
								eq(developerMembers.proofId, proof.value.id),
							),
						),
				)
				yield* Effect.forEach(
					HashSet.fromIterable([
						proof.owner,
						...members.map((member) => member.owner),
					]),
					(owner) =>
						emit(owner, ["proof", next.id, next.status, next.transition], {
							cardUrl: null,
							kind: "AccessChanged",
							issue: null,
							reason: next.reason ?? next.status,
							reportId: null,
							createdAt: now,
						}),
					{ discard: true },
				)
			}
			const dueApps = yield* Rows.stored(
				db
					.select({ cardUrl: developerApps.cardUrl })
					.from(developerApps)
					.where(
						and(
							eq(developerApps.namespace, namespace),
							lte(developerApps.nextCheckAt, now),
							lte(developerApps.leaseUntil, now),
						),
					),
			)
			if (dueApps.length === 0) return
			const owners = yield* possibleOwners
			for (const { cardUrl } of dueApps) {
				const interested = yield* Effect.filter(owners, (owner) =>
					access.allows(owner, cardUrl),
				)
				if (interested.length === 0) continue
				const claimed = yield* claim(cardUrl, now)
				if (Option.isNone(claimed)) continue
				const report = yield* inspections.inspect(cardUrl)
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
				yield* inTransaction(
					Effect.gen(function* () {
						const app = yield* Rows.getApp(db, namespace, cardUrl, true)
						// Another worker took over after the lease ended.
						if (app.monitorToken !== claimed.value) return
						const issues = report.issues.filter(
							(issue) => issue.severity === "blocking",
						)
						const revision = app.monitorRevision + 1
						const changes = [
							...issues
								.filter(
									(issue) =>
										!app.monitorIssues.some(
											(value) => issueKey(value) === issueKey(issue),
										),
								)
								.map((issue) => ({ issue, kind: "IssueAppeared" as const })),
							...app.monitorIssues
								.filter(
									(issue) =>
										!issues.some(
											(value) => issueKey(value) === issueKey(issue),
										),
								)
								.map((issue) => ({ issue, kind: "IssueResolved" as const })),
						]
						const reportId = yield* Effect.sync(randomUUID)
						yield* Rows.saveReport(db, namespace, null, {
							id: reportId,
							cardUrl,
							createdBy: Rows.monitorOwner,
							report,
						})
						for (const owner of interested) {
							if (disabled.some((row) => row.owner === owner)) continue
							for (const change of changes)
								yield* emit(
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
						const observed = report.apps.find(
							(value) => value.candidate.cardUrl === cardUrl,
						)
						yield* Rows.putApp(db, namespace, {
							...app,
							candidate:
								observed === undefined
									? app.candidate
									: { ...observed.candidate, sources: app.candidate.sources },
							nextCheckAt: now + 3600000,
							leaseUntil: 0,
							monitorToken: null,
							monitorRevision: revision,
							monitorIssues: issues,
						})
					}),
				)
			}
		}),
	})
})
export const layer = Layer.effect(DeveloperMonitor, make)
export const layerWorker = Layer.effectDiscard(
	Effect.gen(function* () {
		const monitor = yield* DeveloperMonitor
		yield* monitor.run.pipe(
			Effect.catch((error) =>
				Effect.logWarning(
					"Developer publication monitoring could not complete.",
					error,
				),
			),
			Effect.repeat(Schedule.spaced("30 seconds")),
			Effect.forkScoped,
		)
	}),
)
