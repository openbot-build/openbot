import { Operation } from "@openbot-build/core"
import { PgClient } from "@effect/sql-pg"
import { and, asc, eq, inArray, lt } from "drizzle-orm"
import {
	Clock,
	Context,
	Effect,
	Layer,
	PubSub,
	Schedule,
	Schema,
	Stream,
	type Scope,
} from "effect"
import * as Db from "../database/Database.ts"
import { operations } from "../database/Schema.ts"

/** Every server listens on this channel for changes and for requests to stop. */
export const channel = "openbot_operations"

const codec = Schema.fromJsonString(Operation.Record)
const encode = Schema.encodeEffect(codec)
const decode = Schema.decodeUnknownEffect(codec)

type Database = Effect.Success<typeof Db.make>

/** A notice on the channel: `changed:<namespace>:<id>` or `cancel:<namespace>:<id>`. */
const notice = (kind: "changed" | "cancel", namespace: string, id: string) =>
	`${kind}:${namespace}:${id}`
const parse = (payload: string) => {
	const first = payload.indexOf(":")
	const second = payload.indexOf(":", first + 1)
	return first < 0 || second < 0
		? undefined
		: {
				kind: payload.slice(0, first),
				namespace: payload.slice(first + 1, second),
				id: Operation.Id.make(payload.slice(second + 1)),
			}
}

type Parsed = NonNullable<ReturnType<typeof parse>>

const storageFailure = (cause: unknown) =>
	Effect.logWarning("An Operation could not be stored", cause)

/**
 * The notices of the channel. A failed listen waits and listens again, so a
 * Postgres restart does not end it.
 */
const notices_ = (client: PgClient.PgClient) =>
	Stream.unwrap(
		Effect.map(client.listen(channel), (queue) => Stream.fromQueue(queue)),
	).pipe(
		Stream.map((message) => parse(message.payload)),
		Stream.filter((parsed) => parsed !== undefined),
		Stream.retry(Schedule.spaced("1 second")),
		Stream.orDie,
	)

/**
 * One listener for the channel in each process. Each listen holds a connection of
 * the pool, and OpenBot makes a store for each member, so they share this one.
 */
export class Channel extends Context.Service<
	Channel,
	{ readonly notices: Stream.Stream<Parsed> }
>()("@openbot-build/openbot/operations/StoredOperations/Channel") {}

const makeChannel = Effect.gen(function* () {
	const client = yield* PgClient.PgClient
	const notices = yield* Stream.share(notices_(client), {
		capacity: "unbounded",
	})
	return Channel.of({ notices })
})
export const layerChannel = Layer.effect(Channel, makeChannel)

/** The Operations of one namespace, kept in Postgres. */
export const make = (
	namespace: string,
): Effect.Effect<Operation.Store, never, PgClient.PgClient | Scope.Scope> =>
	Effect.gen(function* () {
		const db = yield* Db.make
		const client = yield* PgClient.PgClient
		const found = yield* Effect.serviceOption(Channel)
		// Without the shared listener, as in a test, the notices stay in this process.
		// A listen of its own would hold a connection that blocks the end of the pool.
		const local = yield* PubSub.unbounded<Parsed>()
		const notify = (kind: "changed" | "cancel", id: string) =>
			found._tag === "Some"
				? client
						.notify(channel, notice(kind, namespace, id))
						.pipe(Effect.ignore)
				: PubSub.publish(local, {
						kind,
						namespace,
						id: Operation.Id.make(id),
					}).pipe(Effect.asVoid)
		const shared =
			found._tag === "Some" ? found.value.notices : Stream.fromPubSub(local)
		const mine = (kind: string) =>
			shared.pipe(
				Stream.filter(
					(parsed) => parsed.kind === kind && parsed.namespace === namespace,
				),
				Stream.map((parsed) => parsed.id),
			)
		const where = (id: Operation.Id) =>
			and(eq(operations.namespace, namespace), eq(operations.id, id))

		const store: Operation.Store = {
			insert: (record) =>
				Effect.gen(function* () {
					const body = yield* encode(record)
					const now = yield* Clock.currentTimeMillis
					yield* db.insert(operations).values({
						namespace,
						id: record.id,
						chat: record.chat,
						status: record.status._tag,
						body,
						heartbeatAt: now,
						startedAt: record.startedAt,
					})
					yield* notify("changed", record.id)
				}).pipe(Effect.catchCause(storageFailure)),
			finish: (id, status, endedAt) =>
				Effect.gen(function* () {
					const [row] = yield* db
						.select()
						.from(operations)
						.where(and(where(id), eq(operations.status, "Running")))
					if (row === undefined) return undefined
					const before = yield* decode(row.body)
					const after: Operation.Record = { ...before, status, endedAt }
					// Only the first end counts, so the update checks the status again.
					const changed = yield* db
						.update(operations)
						.set({ status: status._tag, body: yield* encode(after) })
						.where(and(where(id), eq(operations.status, "Running")))
						.returning({ id: operations.id })
					if (changed.length === 0) return undefined
					yield* notify("changed", id)
					return after
				}).pipe(
					Effect.catchCause((cause) =>
						Effect.as(storageFailure(cause), undefined),
					),
				),
			get: (id) =>
				db
					.select()
					.from(operations)
					.where(where(id))
					.pipe(
						Effect.flatMap((rows) =>
							Effect.forEach(rows.slice(0, 1), (row) => decode(row.body)),
						),
						Effect.map((records) => records[0]),
						Effect.catchCause((cause) =>
							Effect.as(storageFailure(cause), undefined),
						),
					),
			list: (chat) =>
				db
					.select()
					.from(operations)
					.where(
						and(eq(operations.namespace, namespace), eq(operations.chat, chat)),
					)
					.orderBy(asc(operations.startedAt))
					.limit(500)
					.pipe(
						Effect.flatMap((rows) =>
							Effect.forEach(rows, (row) => decode(row.body)),
						),
						Effect.catchCause((cause) => Effect.as(storageFailure(cause), [])),
					),
			changes: mine("changed"),
			requestCancel: (id) => notify("cancel", id),
			cancelRequests: mine("cancel"),
			heartbeat: (ids) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					yield* db
						.update(operations)
						.set({ heartbeatAt: now })
						.where(
							and(
								eq(operations.namespace, namespace),
								inArray(operations.id, [...ids]),
								eq(operations.status, "Running"),
							),
						)
				}).pipe(Effect.catchCause(storageFailure)),
		}
		return store
	})

/** A running Operation whose server has not said that it runs it since some time. */
export interface Stale {
	readonly namespace: string
	readonly record: Operation.Record
}

/** Running Operations in every namespace that no server has seen since `before`. */
export const stale = (db: Database, before: number) =>
	db
		.select()
		.from(operations)
		.where(
			and(eq(operations.status, "Running"), lt(operations.heartbeatAt, before)),
		)
		.limit(500)
		.pipe(
			Effect.flatMap((rows) =>
				Effect.forEach(rows, (row) =>
					Effect.map(decode(row.body), (record): Stale => ({
						namespace: row.namespace,
						record,
					})),
				),
			),
		)

/**
 * Ends a stale Operation as Interrupted. It gives the new record, or nothing when
 * another server ended it first.
 */
export const interrupt = (db: Database, stale: Stale) =>
	Effect.gen(function* () {
		const endedAt = yield* Clock.currentTimeMillis
		const after: Operation.Record = {
			...stale.record,
			status: Operation.Status.Interrupted(),
			endedAt,
		}
		const changed = yield* db
			.update(operations)
			.set({ status: "Interrupted", body: yield* encode(after) })
			.where(
				and(
					eq(operations.namespace, stale.namespace),
					eq(operations.id, stale.record.id),
					eq(operations.status, "Running"),
				),
			)
			.returning({ id: operations.id })
		return changed.length === 0 ? undefined : after
	})
