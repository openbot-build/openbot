import { createHash, randomUUID } from "node:crypto"
import { DeveloperApi as Api } from "@openbot-build/platform-api"
import { Clock, Context, Effect, HashSet, Layer, Schedule } from "effect"
import { DeveloperRepository } from "./DeveloperRepository.ts"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import { AppInspections } from "./AppInspections.ts"
import { issueKey } from "./DeveloperReports.ts"
import { subscriptionId } from "./DeveloperNotifications.ts"

/** This worker's storage access does not include test records, flows or encrypted secrets. */
export class PublicDeveloperRecords extends Context.Service<
	PublicDeveloperRecords,
	Pick<
		typeof DeveloperRepository.Service,
		| "proofs"
		| "members"
		| "apps"
		| "reports"
		| "subscriptions"
		| "notices"
		| "monitors"
		| "transaction"
	>
>()("@openbot-build/platform/apps/DeveloperMonitor/PublicDeveloperRecords") {}
export const layerRecords = Layer.effect(
	PublicDeveloperRecords,
	Effect.map(DeveloperRepository, (records) => ({
		proofs: records.proofs,
		members: records.members,
		apps: records.apps,
		reports: records.reports,
		subscriptions: records.subscriptions,
		notices: records.notices,
		monitors: records.monitors,
		transaction: records.transaction,
	})),
)
export class DeveloperMonitor extends Context.Service<
	DeveloperMonitor,
	{ readonly run: Effect.Effect<void, Api.Failure> }
>()("@openbot-build/platform/apps/DeveloperMonitor") {}

export const make: Effect.Effect<
	typeof DeveloperMonitor.Service,
	never,
	PublicDeveloperRecords | DeveloperAccess | AppInspections
> = Effect.gen(function* () {
	const records = yield* PublicDeveloperRecords
	const access = yield* DeveloperAccess
	const inspections = yield* AppInspections
	const emit = (
		owner: string,
		identity: ReadonlyArray<string | number>,
		value: Omit<Api.Notice, "id" | "readAt">,
	) =>
		Effect.gen(function* () {
			const id = createHash("sha256")
				.update(JSON.stringify([owner, ...identity]))
				.digest("hex")
			const existing = yield* records.notices
				.get(id)
				.pipe(Effect.catchTag("DeveloperNotFound", () => Effect.succeed(null)))
			if (existing === null)
				yield* records.notices.put(id, owner, value.cardUrl ?? "", {
					owner,
					value: { ...value, id, readAt: null },
				})
		})
	return DeveloperMonitor.of({
		run: Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			for (const proof of yield* records.proofs.list()) {
				if (
					proof.value.status === "Relinquished" ||
					proof.value.nextVerificationAt > now
				)
					continue
				const next = yield* access.recheck(proof.value.id)
				if (next.status !== proof.value.status) {
					yield* records.transaction(
						"proof-notice:" + proof.value.id,
						Effect.forEach(
							HashSet.fromIterable([
								proof.owner,
								...(yield* records.members.list({ scope: proof.value.id })).map(
									(member) => member.owner,
								),
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
						),
					)
				}
			}
			for (const listed of yield* records.apps.list()) {
				const cardUrl = listed.candidate.cardUrl
				if (listed.nextCheckAt > now || (listed.leaseUntil ?? 0) > now) continue
				const possibleOwners = HashSet.fromIterable([
					...(yield* records.proofs.list()).map((proof) => proof.owner),
					...(yield* records.members.list()).map((member) => member.owner),
				])
				const interested = yield* Effect.filter(possibleOwners, (owner) =>
					access.authorize(owner, cardUrl).pipe(
						Effect.as(true),
						Effect.catchTags({
							DeveloperNotFound: () => Effect.succeed(false),
							DeveloperForbidden: () => Effect.succeed(false),
						}),
					),
				)
				if (interested.length === 0) continue
				const claimed = yield* records.transaction(
					"monitor:" + cardUrl,
					Effect.gen(function* () {
						const app = yield* records.apps.get(cardUrl)
						if (app.nextCheckAt > now || (app.leaseUntil ?? 0) > now)
							return null
						const token = yield* Effect.sync(randomUUID)
						yield* records.apps.put(cardUrl, "", cardUrl, {
							...app,
							leaseUntil: now + 300000,
							monitorToken: token,
						})
						return token
					}),
				)
				if (claimed === null) continue
				const report = yield* inspections.inspect(cardUrl)
				yield* records.transaction(
					"monitor:" + cardUrl,
					Effect.gen(function* () {
						const app = yield* records.apps.get(cardUrl)
						if (app.monitorToken !== claimed) return
						const previous = yield* records.monitors
							.get(cardUrl)
							.pipe(
								Effect.catchTag("DeveloperNotFound", () =>
									Effect.succeed({ cardUrl, revision: 0, issues: [] }),
								),
							)
						const issues = report.issues.filter(
							(issue) => issue.severity === "blocking",
						)
						const revision = previous.revision + 1
						const changes = [
							...issues
								.filter(
									(issue) =>
										!previous.issues.some(
											(value) => issueKey(value) === issueKey(issue),
										),
								)
								.map((issue) => ({ issue, kind: "IssueAppeared" as const })),
							...previous.issues
								.filter(
									(issue) =>
										!issues.some(
											(value) => issueKey(value) === issueKey(issue),
										),
								)
								.map((issue) => ({ issue, kind: "IssueResolved" as const })),
						]
						const reportId = yield* Effect.sync(randomUUID)
						yield* records.reports.put(reportId, "monitor", cardUrl, {
							owner: "monitor",
							value: { id: reportId, cardUrl, createdBy: "monitor", report },
						})
						const owners = HashSet.fromIterable([
							...(yield* records.proofs.list()).map((proof) => proof.owner),
							...(yield* records.members.list()).map((member) => member.owner),
						])
						for (const owner of owners) {
							const allowed = yield* access.authorize(owner, cardUrl).pipe(
								Effect.as(true),
								Effect.catchTags({
									DeveloperNotFound: () => Effect.succeed(false),
									DeveloperForbidden: () => Effect.succeed(false),
								}),
							)
							if (!allowed) continue
							const subscription = yield* records.subscriptions
								.get(subscriptionId(owner, cardUrl))
								.pipe(
									Effect.catchTag("DeveloperNotFound", () =>
										Effect.succeed(null),
									),
								)
							if (subscription?.value.enabled === false) continue
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
						yield* records.monitors.put(cardUrl, "", cardUrl, {
							cardUrl,
							revision,
							issues,
						})
						const observed = report.apps.find(
							(value) => value.candidate.cardUrl === cardUrl,
						)
						yield* records.apps.put(cardUrl, "", cardUrl, {
							...app,
							candidate:
								observed === undefined
									? app.candidate
									: { ...observed.candidate, sources: app.candidate.sources },
							nextCheckAt: now + 3600000,
							leaseUntil: 0,
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
			Effect.catch(() =>
				Effect.logWarning(
					"Developer publication monitoring could not complete.",
				),
			),
			Effect.repeat(Schedule.spaced("30 seconds")),
			Effect.forkScoped,
		)
	}),
)
