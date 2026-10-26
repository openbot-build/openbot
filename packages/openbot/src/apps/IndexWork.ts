import { AppIndexApi, DeveloperApi } from "@openbot-build/api"
import { Discovery, Index, Indexing } from "@openbot-build/protocol"
import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Match,
	Option,
	Schedule,
	Schema,
} from "effect"
import { and, asc, eq, lte } from "drizzle-orm"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import type { SqlError } from "effect/sql"
import * as Background from "../app/Background.ts"
import { appIndexJobs, appIndexResults } from "../database/Schema.ts"
import { Governance } from "./Governance.ts"
import { IndexNamespace } from "./IndexNamespace.ts"
import { CheckJson } from "./IndexStore.ts"
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
					? yield* Schema.decodeEffect(CheckJson)(row.check)
					: null,
		}
	})

const jobWhere = (namespace: string, cardUrl: string) =>
	and(eq(appIndexJobs.namespace, namespace), eq(appIndexJobs.cardUrl, cardUrl))

/**
 * A database failure, or a stored row that does not decode. The error keeps
 * the failure as its cause, and the callers log it. An `IndexError` stays as
 * it is.
 */
const unavailable = <A, R>(
	self: Effect.Effect<
		A,
		| Index.IndexError
		| EffectDrizzleQueryError
		| SqlError.SqlError
		| Schema.SchemaError,
		R
	>,
): Effect.Effect<A, Index.IndexError, R> =>
	self.pipe(
		Effect.catchTag(
			["EffectDrizzleQueryError", "SqlError", "SchemaError"],
			(cause) =>
				Effect.fail(
					Index.IndexError.make({
						reason: "Unavailable",
						operation: "Public Index work storage",
						cause,
					}),
				),
		),
	)

/**
 * Ask for a new check of an App. A job that waits already keeps its
 * generation and gets the new sources.
 */
export const enqueue = (
	db: Db.Database,
	namespace: string,
	cardUrl: string,
	sources: ReadonlyArray<Discovery.Source>,
): Effect.Effect<Job, Index.IndexError, Crypto.Crypto> =>
	db
		.transaction((tx) =>
			Effect.gen(function* () {
				const crypto = yield* Crypto.Crypto
				yield* tx
					.insert(appIndexJobs)
					.values({ namespace, cardUrl, nextCheckAt: 0 })
					.onConflictDoNothing()
				const row = (yield* tx
					.select()
					.from(appIndexJobs)
					.where(jobWhere(namespace, cardUrl))
					.for("update"))[0]
				if (row === undefined)
					return yield* Index.IndexError.make({
						reason: "Unavailable",
						operation: "Public Index work storage",
					})
				const previousSources = yield* Schema.decodeEffect(sourcesCodec)(
					row.sources,
				)
				const combined = Arr.dedupeWith(
					[...previousSources, ...sources],
					(a, b) => a.role === b.role && a.url === b.url,
				)
				const encoded = yield* Schema.encodeEffect(sourcesCodec)(combined)
				const pending =
					row.generation !== "" && row.generation !== row.completedGeneration
				const next = pending
					? { ...row, sources: encoded }
					: {
							...row,
							generation: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
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
		.pipe(unavailable)

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
				check: yield* Schema.decodeEffect(CheckJson)(result.check),
			})
		}
		return row === undefined ? Option.none() : Option.some(yield* toJob(row))
	}).pipe(unavailable)

export const layer = (options: Options = {}) =>
	Layer.effect(
		IndexWork,
		Effect.gen(function* () {
			const db = yield* Db.make
			const namespace = yield* IndexNamespace
			const indexing = yield* Indexing.Indexing
			const governance = yield* Governance
			const crypto = yield* Crypto.Crypto
			const uuid = crypto.randomUUIDv4().pipe(Effect.orDie)
			const { intervalMs, retryMs } = settings(options)
			const where = (cardUrl: string) => jobWhere(namespace, cardUrl)
			/** Take the next due job that no other worker holds. */
			const claim = (cardUrl?: string) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const token = yield* uuid
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
									? yield* uuid
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
				}).pipe(unavailable)
			const finish = (
				claim: Claim,
				check: AppIndexApi.Check,
				nextCheckAt: number,
			) =>
				db
					.transaction((tx) =>
						Effect.gen(function* () {
							const encoded = yield* Schema.encodeEffect(CheckJson)(check)
							const [finished] = yield* tx
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
							if (finished === undefined)
								return yield* Effect.logWarning(
									"The Public Index claim ended before the check finished. Another worker has the job now, so OpenBot drops this result.",
								).pipe(
									Effect.annotateLogs({
										cardUrl: claim.cardUrl,
										generation: claim.generation,
									}),
								)
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
					.pipe(Effect.asVoid, unavailable)
			/** Releasing the claim is best effort. The lease ends by itself if this fails. */
			const release = (claim: Claim) =>
				db
					.update(appIndexJobs)
					.set({ leaseUntil: 0, claim: null })
					.where(and(where(claim.cardUrl), eq(appIndexJobs.claim, claim.token)))
					.pipe(
						Effect.asVoid,
						Effect.catch((error) =>
							Effect.logWarning(
								"Public Index claim release failed",
								Cause.fail(error),
							).pipe(
								Effect.annotateLogs({
									source: "apps",
									operation: "index-release",
								}),
							),
						),
					)
			const verify = (claim: Claim) =>
				Effect.gen(function* () {
					const sync: Effect.Effect<
						Indexing.SyncResult,
						Index.IndexError | Indexing.IndexingError
					> = Option.match(governance.find(claim.cardUrl), {
						onNone: () =>
							indexing.sync(
								Indexing.Input.make({
									cardUrl: claim.cardUrl,
									sources: claim.sources,
								}),
							),
						onSome: (restriction) =>
							Effect.succeed<Indexing.SyncResult>({
								_tag: "Excluded",
								cardUrl: claim.cardUrl,
								reason: restriction.reason,
							}),
					})
					const outcome = yield* sync.pipe(
						// The saved check has a fixed text, so the log keeps the reason.
						Effect.tapCauseIf(Cause.hasFails, (cause) =>
							Effect.logWarning(
								"Public Index verification could not complete",
								cause,
							).pipe(
								Effect.annotateLogs({
									cardUrl: claim.cardUrl,
									generation: claim.generation,
								}),
							),
						),
						Effect.result,
					)
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
				})
			return IndexWork.of({
				runOne: Effect.fn("IndexWork.runOne")(function* (cardUrl) {
					// A claim and its release step are one step. An interruption can
					// stop only the check, and then the release step still runs.
					return yield* Effect.uninterruptibleMask((restore) =>
						claim(cardUrl).pipe(
							Effect.flatMap(
								Option.match({
									onNone: () => Effect.succeed(false),
									onSome: (held) =>
										restore(verify(held)).pipe(
											Effect.onError(() => release(held)),
										),
								}),
							),
						),
					)
				}),
			})
		}),
	)

/**
 * Each OpenBot process runs one scoped worker. When a process stops before it
 * can release a claim, the claim comes back when its lease ends.
 */
export const layerWorker = (options: Options = {}) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const work = yield* IndexWork
			const { retryMs } = settings(options)
			// Check due jobs one after another until no job is due.
			const drain = work
				.runOne()
				.pipe(Effect.repeat({ while: (processed) => processed }), Effect.asVoid)
			yield* Background.repeat(drain, {
				schedule: Schedule.spaced(retryMs),
				message: "Public Index verification failed",
			}).pipe(Effect.annotateLogs({ source: "apps", operation: "index-sync" }))
		}),
	)
