import {
	AppIndex,
	Execution,
	ServiceId,
	type ServiceIdentity,
} from "@openbot-build/domain"
import { Discovery, Index, Indexing } from "@openbot-build/protocol"
import {
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Match,
	Option,
	Schema,
} from "effect"
import { Hex } from "effect/encoding"
import { SqlClient } from "effect/sql"
import { and, eq } from "drizzle-orm"
import {
	appIndexEntries,
	appIndexJobs,
	appIndexResults,
} from "../database/Schema.ts"
import * as Db from "../database/Database.ts"
import {
	Store,
	commandActor,
	storage,
	transactionFailures,
	type Key,
	type Fence,
} from "../execution/Store.ts"
import { Governance } from "./Governance.ts"
import { IndexNamespace } from "./IndexNamespace.ts"
import { CheckJson } from "./IndexStore.ts"

export const workflowName = "openbot.index-watch"
export const serviceId = ServiceId.make("public-index")
export const identity: ServiceIdentity = {
	owner: { kind: "platform" },
	actor: { kind: "service", serviceId },
}
export const nextSignal = (generation: string) => `next:${generation}`
export interface Options {
	readonly intervalMs?: number
	readonly retryMs?: number
}
export const Job = AppIndex.Job
export type Job = AppIndex.Job
const sourcesCodec = Schema.fromJsonString(Schema.Array(Discovery.Source))
const entryCodec = Schema.fromJsonString(Index.Entry)
const Reference = Schema.Struct({
	indexNamespace: Schema.String,
	cardUrl: Schema.String,
})
export const CheckInput = Schema.Struct({
	cardUrl: Schema.String,
	sources: Schema.Array(Discovery.Source),
	previous: Schema.NullOr(Index.Entry),
})
export type CheckInput = typeof CheckInput.Type
export const CheckResult = Schema.TaggedUnion({
	Checked: { result: Indexing.SyncResult },
	Failed: { failure: Execution.Failure },
})
export type CheckResult = typeof CheckResult.Type
const jobWhere = (namespace: string, cardUrl: string) =>
	and(eq(appIndexJobs.namespace, namespace), eq(appIndexJobs.cardUrl, cardUrl))
const toJob = (row: typeof appIndexJobs.$inferSelect) =>
	Effect.gen(function* () {
		const completed = row.generation === row.completedGeneration
		return {
			cardUrl: row.cardUrl,
			generation: row.generation,
			requestedAt: row.requestedAt,
			status: completed
				? "Completed"
				: row.startedAt === 0
					? "Waiting"
					: "Verifying",
			check:
				completed && row.check !== null
					? yield* Schema.decodeEffect(CheckJson)(row.check)
					: null,
		} satisfies Job
	})

/** The Index owns checks and results. The shared engine owns all scheduling. */
const make = (options: Options) =>
	Effect.gen(function* () {
		const db = yield* Db.make
		const sql = yield* SqlClient.SqlClient
		const store = yield* Store
		const namespace = yield* IndexNamespace
		const inspection = yield* Indexing.PublicationInspection
		const governance = yield* Governance
		const crypto = yield* Crypto.Crypto
		const executionNamespace = `index:${namespace}`
		const where = (cardUrl: string) => jobWhere(namespace, cardUrl)
		const row = (cardUrl: string, lock = false) => {
			const query = db.select().from(appIndexJobs).where(where(cardUrl))
			return (lock ? query.for("update") : query).pipe(Effect.map(Arr.head))
		}
		const load = Effect.fn("IndexWork.load")(function* (
			key: Key,
			lock = false,
		) {
			const saved = yield* store.loadService(key, serviceId)
			const ref = yield* Schema.decodeUnknownEffect(Reference)(saved.input)
			if (
				key.namespace !== executionNamespace ||
				ref.indexNamespace !== namespace ||
				saved.identity.owner.kind !== "platform"
			)
				return yield* Execution.Forbidden.make({})
			const found = yield* row(ref.cardUrl, lock)
			if (Option.isNone(found) || found.value.executionId !== key.id)
				return yield* Execution.NotFound.make({ id: key.id })
			return { saved, row: found.value }
		}, transactionFailures)
		const authorize = (key: Key) =>
			load(key).pipe(Effect.asVoid, Effect.catchTag("SchemaError", Effect.die))
		const request = Effect.fn("IndexWork.request")(function* (
			cardUrl: string,
			sources: ReadonlyArray<Discovery.Source>,
		) {
			return yield* sql.withTransaction(
				Effect.gen(function* () {
					yield* db
						.insert(appIndexJobs)
						.values({ namespace, cardUrl, nextCheckAt: 0 })
						.onConflictDoNothing()
					const found = yield* row(cardUrl, true)
					if (Option.isNone(found))
						return yield* Effect.die("The Index row is missing after insert.")
					const current = found.value
					const combined = Arr.dedupeWith(
						[
							...(yield* Schema.decodeEffect(sourcesCodec)(current.sources)),
							...sources,
						],
						(a, b) => a.role === b.role && a.url === b.url,
					)
					let executionId =
						current.executionId === null
							? null
							: Execution.Id.make(current.executionId)
					if (
						executionId !== null &&
						Execution.isTerminal(
							(yield* store.get({
								namespace: executionNamespace,
								id: executionId,
							})).status,
						)
					)
						executionId = null
					const pending =
						executionId !== null &&
						current.generation !== "" &&
						current.generation !== current.completedGeneration
					const generation = pending
						? current.generation
						: yield* crypto.randomUUIDv4()
					if (executionId === null) {
						const resourceId = Hex.encode(
							yield* crypto.digest(
								"SHA-256",
								new TextEncoder().encode(cardUrl),
							),
						)
						executionId = (yield* store.submit(
							executionNamespace,
							Execution.CommandKey.make(`watch:${generation}`),
							{
								workflow: workflowName,
								identity,
								resource: { kind: "IndexWatch", id: resourceId },
								input: { indexNamespace: namespace, cardUrl },
							},
						)).executionId
					}
					const next = {
						...current,
						executionId,
						generation,
						sources: yield* Schema.encodeEffect(sourcesCodec)(combined),
						requestedAt: pending
							? current.requestedAt
							: yield* Clock.currentTimeMillis,
						startedAt: pending ? current.startedAt : 0,
						nextCheckAt: 0,
					}
					yield* db.update(appIndexJobs).set(next).where(where(cardUrl))
					if (!pending && current.executionId === executionId)
						yield* store.notify(
							{ namespace: executionNamespace, id: executionId },
							Execution.CommandKey.make(`check:${generation}`),
							commandActor(identity),
							nextSignal(current.completedGeneration ?? ""),
						)
					return {
						job: yield* toJob(next),
						execution: { namespace: executionNamespace, id: executionId },
					}
				}),
			)
		}, transactionFailures)
		const job = Effect.fn("IndexWork.job")(function* (
			cardUrl: string,
			generation?: string,
		) {
			const found = yield* row(cardUrl)
			if (
				generation !== undefined &&
				(Option.isNone(found) || found.value.generation !== generation)
			) {
				const result = Arr.head(
					yield* db
						.select()
						.from(appIndexResults)
						.where(
							and(
								eq(appIndexResults.namespace, namespace),
								eq(appIndexResults.cardUrl, cardUrl),
								eq(appIndexResults.generation, generation),
							),
						),
				)
				if (Option.isNone(result)) return Option.none<Job>()
				return Option.some<Job>({
					cardUrl,
					generation,
					requestedAt: result.value.finishedAt,
					status: "Completed",
					check: yield* Schema.decodeEffect(CheckJson)(result.value.check),
				})
			}
			return Option.isNone(found)
				? Option.none<Job>()
				: Option.some(yield* toJob(found.value))
		}, transactionFailures)
		const begin = Effect.fn("IndexWork.begin")(function* (fence: Fence) {
			return yield* sql.withTransaction(
				Effect.gen(function* () {
					// Commands and commits take the App row before the execution row.
					const current = yield* load(fence, true)
					const now = yield* Clock.currentTimeMillis
					const pending =
						current.row.generation !== "" &&
						current.row.generation !== current.row.completedGeneration
					const generation = pending
						? current.row.generation
						: yield* crypto.randomUUIDv4()
					return yield* store.commit(
						fence,
						current.saved.record.status === "waiting"
							? { status: "running" }
							: {},
						Effect.gen(function* () {
							const next = {
								...current.row,
								generation,
								requestedAt: pending ? current.row.requestedAt : now,
								startedAt:
									pending && current.row.startedAt > 0
										? current.row.startedAt
										: now,
							}
							yield* db
								.update(appIndexJobs)
								.set(next)
								.where(where(next.cardUrl))
							const previous = Arr.head(
								yield* db
									.select()
									.from(appIndexEntries)
									.where(
										and(
											eq(appIndexEntries.namespace, namespace),
											eq(appIndexEntries.cardUrl, next.cardUrl),
										),
									),
							)
							return {
								generation,
								input: {
									cardUrl: next.cardUrl,
									sources: yield* Schema.decodeEffect(sourcesCodec)(
										next.sources,
									),
									previous: Option.isNone(previous)
										? null
										: yield* Schema.decodeEffect(entryCodec)(
												previous.value.body,
											),
								} satisfies CheckInput,
							}
						}),
					)
				}),
			)
		}, transactionFailures)
		const restriction = (cardUrl: string) =>
			governance.find(cardUrl).pipe(storage)
		const inspect = Effect.fn("IndexWork.inspect")(function* (
			input: CheckInput,
			restriction: Option.Option<AppIndex.Restriction>,
		) {
			if (Option.isSome(restriction))
				return {
					_tag: "Excluded",
					cardUrl: input.cardUrl,
					reason: restriction.value.reason,
				} satisfies Indexing.SyncResult
			const entry = Option.fromNullishOr(input.previous)
			const inspected = yield* inspection.inspect(
				Indexing.Input.make(input),
				entry,
			)
			return Match.value(inspected).pipe(
				Match.tagsExhaustive({
					Eligible: ({ entry }) =>
						({ _tag: "Indexed", entry }) satisfies Indexing.SyncResult,
					Excluded: ({ cardUrl, reason, withdraw }) =>
						({
							_tag: withdraw && Option.isSome(entry) ? "Withdrawn" : "Excluded",
							cardUrl,
							reason,
						}) satisfies Indexing.SyncResult,
					Unconfirmed: (result) => result,
				}),
			)
		}, transactionFailures)
		const complete = Effect.fn("IndexWork.complete")(function* (
			fence: Fence,
			generation: string,
			outcome: CheckResult,
		) {
			return yield* sql.withTransaction(
				Effect.gen(function* () {
					const current = yield* load(fence, true)
					if (
						current.saved.generation !== fence.generation ||
						current.row.generation !== generation
					)
						return yield* Execution.Conflict.make({ id: fence.id })
					if (current.row.completedGeneration === generation) return
					const attemptedAt = yield* Clock.currentTimeMillis
					const check: AppIndex.Check =
						outcome._tag === "Failed"
							? {
									_tag: "Failed",
									attemptedAt,
									reason: "Public verification could not complete.",
								}
							: Match.value(outcome.result).pipe(
									Match.tagsExhaustive({
										Indexed: () => ({ _tag: "Indexed", attemptedAt }) as const,
										Excluded: ({ reason }) =>
											({ _tag: "Excluded", attemptedAt, reason }) as const,
										Withdrawn: ({ reason }) =>
											({ _tag: "Withdrawn", attemptedAt, reason }) as const,
										Unconfirmed: ({ reason }) =>
											({ _tag: "Unconfirmed", attemptedAt, reason }) as const,
									}),
								)
					const encoded = yield* Schema.encodeEffect(CheckJson)(check)
					const delay =
						check._tag === "Failed" || check._tag === "Unconfirmed"
							? (options.retryMs ?? 60000)
							: (options.intervalMs ?? 3600000)
					yield* store.commit(
						fence,
						{
							events: [
								{
									_tag: "Result",
									resource: { kind: "IndexCheck", id: generation },
								},
							],
						},
						Effect.gen(function* () {
							if (outcome._tag === "Checked") {
								if (outcome.result._tag === "Indexed") {
									const entry = outcome.result.entry
									const body = yield* Schema.encodeEffect(entryCodec)(entry)
									yield* db
										.insert(appIndexEntries)
										.values({ namespace, cardUrl: entry.cardUrl, body })
										.onConflictDoUpdate({
											target: [
												appIndexEntries.namespace,
												appIndexEntries.cardUrl,
											],
											set: { body },
										})
								} else if (outcome.result._tag === "Withdrawn")
									yield* db
										.delete(appIndexEntries)
										.where(
											and(
												eq(appIndexEntries.namespace, namespace),
												eq(appIndexEntries.cardUrl, current.row.cardUrl),
											),
										)
							}
							yield* db
								.insert(appIndexResults)
								.values({
									namespace,
									cardUrl: current.row.cardUrl,
									generation,
									check: encoded,
									finishedAt: attemptedAt,
								})
								.onConflictDoNothing()
							yield* db
								.update(appIndexJobs)
								.set({
									check: encoded,
									completedGeneration: generation,
									nextCheckAt: attemptedAt + delay,
								})
								.where(where(current.row.cardUrl))
						}),
					)
				}),
			)
		}, transactionFailures)
		return {
			request,
			job,
			load,
			authorize,
			begin,
			restriction,
			inspect,
			complete,
		}
	})
export class IndexWork extends Context.Service<
	IndexWork,
	Effect.Success<ReturnType<typeof make>>
>()("@openbot-build/openbot/apps/IndexWork") {}
export const layer = (options: Options = {}) =>
	Layer.effect(IndexWork, make(options))
