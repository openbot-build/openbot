// These are plain query functions that take the database first. A pipeable form does not help here.
// @effect-diagnostics missingPipeableSignature:off
import { AppIndexApi, DeveloperApi } from "@openbot-build/api"
import { Discovery, Index, Indexing } from "@openbot-build/protocol"
import {
	Clock,
	Context,
	Effect,
	Layer,
	Match,
	Option,
	Schedule,
	Schema,
} from "effect"
import { and, asc, eq, lte } from "drizzle-orm"
import { appIndexJobs, appIndexResults } from "../database/Schema.ts"
import { Governance } from "./Governance.ts"
import { IndexNamespace } from "./IndexNamespace.ts"
import * as Db from "../database/Database.ts"

export interface Options {
	readonly intervalMs?: number
	readonly retryMs?: number
}
/** Fill in the default wait times once, when the Layer is built. */
const settings = (options: Options) => ({
	intervalMs: options.intervalMs ?? 3600000,
	retryMs: options.retryMs ?? 60000,
})
export const Job = Schema.Struct({
	cardUrl: Schema.String,
	generation: Schema.String,
	status: DeveloperApi.IndexJobStatus,
	check: Schema.NullOr(AppIndexApi.Check),
	requestedAt: Schema.Finite,
})
export type Job = typeof Job.Type
/** A job that one worker holds for a short lease. */
interface Claim {
	readonly cardUrl: string
	readonly token: string
	readonly generation: string
	readonly sources: ReadonlyArray<Discovery.Source>
}
export class IndexWork extends Context.Service<
	IndexWork,
	{
		readonly runOne: (
			cardUrl?: string,
		) => Effect.Effect<boolean, Index.IndexError>
	}
>()("@openbot-build/openbot/apps/IndexWork") {}

const unavailable = () =>
	new Index.IndexError({
		reason: "Unavailable",
		operation: "Public Index work storage",
	})
const checkCodec = Schema.fromJsonString(AppIndexApi.Check)
const sourcesCodec = Schema.fromJsonString(Schema.Array(Discovery.Source))
const toJob = (
	row: typeof appIndexJobs.$inferSelect,
): Effect.Effect<Job, Schema.SchemaError> =>
	Effect.gen(function* () {
		const completed = row.generation === row.completedGeneration
		return {
			cardUrl: row.cardUrl,
			generation: row.generation,
			requestedAt: row.requestedAt,
			status: completed
				? "Completed"
				: row.claim === null
					? "Waiting"
					: "Verifying",
			check:
				completed && row.check !== null
					? yield* Schema.decodeEffect(checkCodec)(row.check)
					: null,
		}
	})

const jobWhere = (namespace: string, cardUrl: string) =>
	and(eq(appIndexJobs.namespace, namespace), eq(appIndexJobs.cardUrl, cardUrl))

/**
 * Ask for a new check of an App. A job that waits already keeps its
 * generation and gets the new sources.
 */
export const enqueue = (
	db: Db.Database,
	namespace: string,
	cardUrl: string,
	sources: ReadonlyArray<Discovery.Source>,
): Effect.Effect<Job, Index.IndexError> =>
	db
		.transaction((tx) =>
			Effect.gen(function* () {
				yield* tx
					.insert(appIndexJobs)
					.values({ namespace, cardUrl, nextCheckAt: 0 })
					.onConflictDoNothing()
				const row = (yield* tx
					.select()
					.from(appIndexJobs)
					.where(jobWhere(namespace, cardUrl))
					.for("update"))[0]
				if (row === undefined) return yield* unavailable()
				const previousSources = yield* Schema.decodeEffect(sourcesCodec)(
					row.sources,
				)
				const combined = [...previousSources, ...sources].filter(
					(source, index, values) =>
						values.findIndex(
							(value) => value.role === source.role && value.url === source.url,
						) === index,
				)
				const encoded = yield* Schema.encodeEffect(sourcesCodec)(combined)
				const pending =
					row.generation !== "" && row.generation !== row.completedGeneration
				const next = pending
					? { ...row, sources: encoded }
					: {
							...row,
							generation: yield* Effect.sync(() => crypto.randomUUID()),
							sources: encoded,
							requestedAt: yield* Clock.currentTimeMillis,
							startedAt: 0,
							nextCheckAt: 0,
						}
				yield* tx
					.update(appIndexJobs)
					.set(next)
					.where(jobWhere(namespace, cardUrl))
				return yield* toJob(next)
			}),
		)
		.pipe(Effect.mapError(unavailable))

/** Read the job of an App, or the saved result of one of its generations. */
export const job = (
	db: Db.Database,
	namespace: string,
	cardUrl: string,
	generation?: string,
): Effect.Effect<Option.Option<Job>, Index.IndexError> =>
	Effect.gen(function* () {
		const row = (yield* db
			.select()
			.from(appIndexJobs)
			.where(jobWhere(namespace, cardUrl)))[0]
		if (
			generation !== undefined &&
			(row === undefined || row.generation !== generation)
		) {
			const result = (yield* db
				.select()
				.from(appIndexResults)
				.where(
					and(
						eq(appIndexResults.namespace, namespace),
						eq(appIndexResults.cardUrl, cardUrl),
						eq(appIndexResults.generation, generation),
					),
				))[0]
			if (result === undefined) return Option.none()
			return Option.some<Job>({
				cardUrl,
				generation,
				status: "Completed",
				requestedAt: result.finishedAt,
				check: yield* Schema.decodeEffect(checkCodec)(result.check),
			})
		}
		return row === undefined ? Option.none() : Option.some(yield* toJob(row))
	}).pipe(Effect.mapError(unavailable))

export const layer = (options: Options = {}) =>
	Layer.effect(
		IndexWork,
		Effect.gen(function* () {
			const db = yield* Db.make
			const namespace = yield* IndexNamespace
			const indexing = yield* Indexing.Indexing
			const governance = yield* Governance
			const { intervalMs, retryMs } = settings(options)
			const where = (cardUrl: string) => jobWhere(namespace, cardUrl)
			/** Take the next due job that no other worker holds. */
			const claim = (cardUrl?: string) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const token = yield* Effect.sync(() => crypto.randomUUID())
					return yield* db.transaction((tx) =>
						Effect.gen(function* () {
							const row = (yield* tx
								.select()
								.from(appIndexJobs)
								.where(
									and(
										eq(appIndexJobs.namespace, namespace),
										lte(appIndexJobs.nextCheckAt, now),
										lte(appIndexJobs.leaseUntil, now),
										cardUrl === undefined
											? undefined
											: eq(appIndexJobs.cardUrl, cardUrl),
									),
								)
								.orderBy(
									asc(appIndexJobs.nextCheckAt),
									asc(appIndexJobs.cardUrl),
								)
								.limit(1)
								.for("update", { skipLocked: true }))[0]
							if (row === undefined) return Option.none<Claim>()
							const generation =
								row.generation === "" ||
								row.generation === row.completedGeneration
									? yield* Effect.sync(() => crypto.randomUUID())
									: row.generation
							yield* tx
								.update(appIndexJobs)
								.set({
									generation,
									claim: token,
									leaseUntil: now + 300000,
									startedAt: now,
									requestedAt:
										generation === row.generation ? row.requestedAt : now,
								})
								.where(where(row.cardUrl))
							return Option.some<Claim>({
								cardUrl: row.cardUrl,
								token,
								generation,
								sources: yield* Schema.decodeEffect(sourcesCodec)(row.sources),
							})
						}),
					)
				}).pipe(Effect.mapError(unavailable))
			const finish = (
				claim: Claim,
				check: AppIndexApi.Check,
				nextCheckAt: number,
			) =>
				db
					.transaction((tx) =>
						Effect.gen(function* () {
							const encoded = yield* Schema.encodeEffect(checkCodec)(check)
							const rows = yield* tx
								.update(appIndexJobs)
								.set({
									check: encoded,
									completedGeneration: claim.generation,
									nextCheckAt,
									leaseUntil: 0,
									claim: null,
								})
								.where(
									and(
										where(claim.cardUrl),
										eq(appIndexJobs.claim, claim.token),
									),
								)
								.returning({ generation: appIndexJobs.generation })
							const [finished] = rows
							if (rows.length !== 1 || finished === undefined)
								return yield* unavailable()
							yield* tx
								.insert(appIndexResults)
								.values({
									namespace,
									cardUrl: claim.cardUrl,
									generation: finished.generation,
									check: encoded,
									finishedAt: yield* Clock.currentTimeMillis,
								})
								.onConflictDoNothing()
						}),
					)
					.pipe(Effect.asVoid, Effect.mapError(unavailable))
			const release = (claim: Claim) =>
				db
					.update(appIndexJobs)
					.set({ leaseUntil: 0, claim: null })
					.where(and(where(claim.cardUrl), eq(appIndexJobs.claim, claim.token)))
					.pipe(Effect.asVoid, Effect.mapError(unavailable))
			const verify = (claim: Claim) =>
				Effect.gen(function* () {
					const outcome = yield* Option.match(governance.find(claim.cardUrl), {
						onNone: () =>
							indexing.sync({
								cardUrl: claim.cardUrl,
								sources: claim.sources,
							}),
						onSome: (restriction) =>
							Effect.succeed<Indexing.SyncResult>({
								_tag: "Excluded",
								cardUrl: claim.cardUrl,
								reason: restriction.reason,
							}),
					}).pipe(Effect.result)
					const attemptedAt = yield* Clock.currentTimeMillis
					const check: AppIndexApi.Check = Match.value(outcome).pipe(
						Match.tag(
							"Failure",
							() =>
								({
									_tag: "Failed",
									attemptedAt,
									reason: "Public verification could not complete.",
								}) as const,
						),
						Match.tag("Success", ({ success }) =>
							Match.value(success).pipe(
								Match.tagsExhaustive({
									Indexed: () => ({ _tag: "Indexed", attemptedAt }) as const,
									Excluded: ({ reason }) =>
										({ _tag: "Excluded", attemptedAt, reason }) as const,
									Withdrawn: ({ reason }) =>
										({ _tag: "Withdrawn", attemptedAt, reason }) as const,
									Unconfirmed: ({ reason }) =>
										({ _tag: "Unconfirmed", attemptedAt, reason }) as const,
								}),
							),
						),
						Match.exhaustive,
					)
					const delay = Match.value(check).pipe(
						Match.tag("Failed", "Unconfirmed", () => retryMs),
						Match.orElse(() => intervalMs),
					)
					yield* finish(claim, check, attemptedAt + delay)
					return true
				}).pipe(
					Effect.onError(() =>
						// Releasing the claim is best effort. The lease ends by itself if this fails.
						release(claim).pipe(
							Effect.catch((error) =>
								Effect.logWarning("Public Index claim release failed", {
									source: "apps",
									operation: "index-release",
									reason: error.reason,
								}),
							),
						),
					),
				)
			return IndexWork.of({
				runOne: Effect.fn("IndexWork.runOne")(function* (cardUrl) {
					return yield* Option.match(yield* claim(cardUrl), {
						onNone: () => Effect.succeed(false),
						onSome: verify,
					})
				}),
			})
		}),
	)

/** Each OpenBot process runs one scoped worker. It recovers saved claims at startup. */
export const layerWorker = (options: Options = {}) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const db = yield* Db.make
			const namespace = yield* IndexNamespace
			const work = yield* IndexWork
			const { retryMs } = settings(options)
			// Claims from before the restart have no worker any more.
			yield* db
				.update(appIndexJobs)
				.set({ claim: null, leaseUntil: 0 })
				.where(eq(appIndexJobs.namespace, namespace))
				.pipe(Effect.mapError(unavailable))
			const drain: Effect.Effect<void, Index.IndexError> = Effect.suspend(() =>
				work
					.runOne()
					.pipe(
						Effect.flatMap((processed) => (processed ? drain : Effect.void)),
					),
			)
			yield* drain.pipe(
				Effect.catch(() =>
					Effect.logError("Public Index verification failed", {
						source: "apps",
						operation: "index-sync",
					}),
				),
				Effect.repeat(Schedule.spaced(retryMs)),
				Effect.forkScoped,
			)
		}),
	)
