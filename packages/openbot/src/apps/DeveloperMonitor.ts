import { DeveloperApi as Api } from "@openbot-build/api"
import { PgClient } from "@effect/sql-pg"
import { and, eq, lte, ne } from "drizzle-orm"
import {
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	HashSet,
	Layer,
	Option,
	Schedule,
	Schema,
} from "effect"
import { Hex } from "effect/encoding"
import * as Background from "../app/Background.ts"
import {
	developerApps,
	developerMembers,
	developerProofs,
	developerSubscriptions,
} from "../database/Schema.ts"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import { AppInspections } from "./AppInspections.ts"
import { issueKey, sameIssue } from "./DeveloperReports.ts"
import * as Rows from "./DeveloperRows.ts"
import { IndexNamespace } from "./IndexNamespace.ts"
import * as Db from "../database/Database.ts"

export class DeveloperMonitor extends Context.Service<
	DeveloperMonitor,
	{ readonly run: Effect.Effect<void, Api.Failure> }
>()("@openbot-build/openbot/apps/DeveloperMonitor") {}

/** The JSON text of a notice identity. Its digest is the notice ID. */
const NoticeIdentity = Schema.fromJsonString(
	Schema.Array(Schema.Union([Schema.String, Schema.Finite])),
)

export const make: Effect.Effect<
	typeof DeveloperMonitor.Service,
	never,
	PgClient.PgClient | DeveloperAccess | AppInspections | Crypto.Crypto
> = Effect.gen(function* () {
	const db = yield* Db.make
	const inTransaction = Rows.transaction(yield* PgClient.PgClient)
	const namespace = yield* IndexNamespace
	const access = yield* DeveloperAccess
	const inspections = yield* AppInspections
	const crypto = yield* Crypto.Crypto
	const newId = crypto.randomUUIDv4().pipe(Effect.orDie)
	/** Post a notice once. The same owner and identity always give the same notice ID. */
	const emit = Effect.fn("DeveloperMonitor.emit")(function* (
		owner: string,
		identity: ReadonlyArray<string | number>,
		value: Omit<Api.Notice, "id" | "readAt">,
	) {
		const text = yield* Schema.encodeEffect(NoticeIdentity)([
			owner,
			...identity,
		]).pipe(Effect.orDie)
		const digest = yield* crypto
			.digest("SHA-256", new TextEncoder().encode(text))
			.pipe(Effect.orDie)
		yield* Rows.postNotice(db, namespace, owner, {
			...value,
			id: Hex.encode(digest),
			readAt: null,
		})
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
		return HashSet.fromIterable(
			Arr.map([...proofs, ...members], (row) => row.owner),
		)
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
				const token = yield* newId
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
	/**
	 * Take a due proof for one check, unless another worker took it first. A second
	 * worker waits for the row lock, then finds that the proof is no longer due.
	 * If the check stops before its end, the proof is due again when the lease ends.
	 */
	const claimProof = (id: string, now: number) =>
		Effect.gen(function* () {
			// The loop can take longer than the lease, so the lease starts at this time.
			const leaseUntil = (yield* Clock.currentTimeMillis) + 300000
			const rows = yield* Rows.stored(
				db
					.update(developerProofs)
					.set({ nextVerificationAt: leaseUntil })
					.where(
						and(
							eq(developerProofs.namespace, namespace),
							eq(developerProofs.id, id),
							ne(developerProofs.status, "Relinquished"),
							lte(developerProofs.nextVerificationAt, now),
						),
					)
					.returning(),
			)
			return Arr.head(rows)
		})
	/**
	 * Check a proof again, and tell its owner and members when its status changed.
	 * `row` is the claimed row, so the status it compares with is current.
	 */
	const checkProof = Effect.fn("DeveloperMonitor.checkProof")(function* (
		row: typeof developerProofs.$inferSelect,
		now: number,
	) {
		const proof = yield* Rows.decodeProof(row)
		const next = yield* access.recheck(proof.value.id)
		if (next.status === proof.value.status) return
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
				...Arr.map(members, (member) => member.owner),
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
	})
	/** Inspect an App again, and tell the interested owners which issues changed. */
	const checkApp = Effect.fn("DeveloperMonitor.checkApp")(function* (
		cardUrl: string,
		owners: HashSet.HashSet<string>,
		now: number,
	) {
		const interested = yield* Effect.filter(owners, (owner) =>
			access.allows(owner, cardUrl),
		)
		if (interested.length === 0) return
		const claimed = yield* claim(cardUrl, now)
		if (Option.isNone(claimed)) return
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
				const reportId = yield* newId
				yield* Rows.saveReport(db, namespace, null, {
					id: reportId,
					cardUrl,
					createdBy: Rows.monitorOwner,
					report,
				})
				for (const owner of interested) {
					if (Arr.some(disabled, (row) => row.owner === owner)) continue
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
					leaseUntil: 0,
					monitorToken: null,
					monitorRevision: revision,
					monitorIssues: issues,
				})
			}),
		)
	})
	return DeveloperMonitor.of({
		run: Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const dueProofs = yield* Rows.stored(
				db
					.select({ id: developerProofs.id })
					.from(developerProofs)
					.where(
						and(
							eq(developerProofs.namespace, namespace),
							ne(developerProofs.status, "Relinquished"),
							lte(developerProofs.nextVerificationAt, now),
						),
					),
			)
			// One proof or App that fails does not stop the checks of the others.
			yield* Effect.forEach(
				dueProofs,
				(row) =>
					claimProof(row.id, now).pipe(
						Effect.flatMap(
							Option.match({
								onNone: () => Effect.void,
								onSome: (claimed) => checkProof(claimed, now),
							}),
						),
						Background.logFailure(
							"The developer monitor could not check a proof again.",
						),
						Effect.annotateLogs({ proofId: row.id }),
					),
				{ discard: true },
			)
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
			yield* Effect.forEach(
				dueApps,
				({ cardUrl }) =>
					checkApp(cardUrl, owners, now).pipe(
						Background.logFailure(
							"The developer monitor could not check an App.",
						),
						Effect.annotateLogs({ cardUrl }),
					),
				{ discard: true },
			)
		}),
	})
})
export const layer = Layer.effect(DeveloperMonitor, make)
export const layerWorker = Layer.effectDiscard(
	Effect.gen(function* () {
		const monitor = yield* DeveloperMonitor
		yield* Background.repeat(monitor.run, {
			schedule: Schedule.spaced("30 seconds"),
			message: "Developer publication monitoring could not complete.",
		})
	}),
)
