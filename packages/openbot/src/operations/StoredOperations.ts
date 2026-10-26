import { Operation } from "@openbot-build/core"
import { PgClient } from "@effect/sql-pg"
import { and, asc, eq, inArray, lt } from "drizzle-orm"
import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	Effect,
	Layer,
	Schedule,
	Schema,
	Stream,
	String as Str,
	type Scope,
} from "effect"
import * as Background from "../app/Background.ts"
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
	const [kind, namespace, ...id] = Str.split(payload, ":")
	return namespace === undefined || id.length === 0
		? undefined
		: { kind, namespace, id: Operation.Id.make(Arr.join(id, ":")) }
}

type Parsed = NonNullable<ReturnType<typeof parse>>

/**
 * Logs a failure of the store, and gives `fallback`. The store of core never
 * fails, so the Operation goes on without the write. A stop is not a failure,
 * so it stays a stop.
 */
const storageFailure =
	<B>(fallback: B) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | B, never, R> =>
		effect.pipe(
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.interrupt
					: Effect.logWarning("An Operation could not be stored", cause).pipe(
							Effect.as(fallback),
						),
			),
		)

/**
 * The notices of the channel. A failed listen is logged, and the listener
 * waits and listens again, so a Postgres restart does not end it.
 */
const notices_ = (client: PgClient.PgClient) =>
	Stream.unwrap(
		Effect.map(client.listen(channel), (queue) => Stream.fromQueue(queue)),
	).pipe(
		Stream.map((message) => parse(message.payload)),
		Stream.filter((parsed) => parsed !== undefined),
		Stream.tapError((error) =>
			Effect.logWarning(
				"The Operations listener stopped. It listens again in one second.",
				Cause.fail(error),
			),
		),
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

/**
 * The Operations of one namespace, kept in Postgres. Every server, also the one
 * that made a change, hears of it through the shared listener (`Channel`).
 */
export const make = (
	namespace: string,
): Effect.Effect<
	Operation.Store,
	never,
	PgClient.PgClient | Channel | Scope.Scope
> =>
	Effect.gen(function* () {
		const db = yield* Db.make
		const client = yield* PgClient.PgClient
		const listener = yield* Channel
		// A notice that is lost is logged. A waiter also reads the records again each second.
		const notify = (kind: "changed" | "cancel", id: string) =>
			client
				.notify(channel, notice(kind, namespace, id))
				.pipe(
					Background.logFailure(
						"A notice about an Operation could not be sent",
					),
				)
		const mine = (kind: string) =>
			listener.notices.pipe(
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
				}).pipe(storageFailure(undefined)),
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
				}).pipe(storageFailure(undefined)),
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
						storageFailure(undefined),
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
						storageFailure([]),
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
				}).pipe(storageFailure(undefined)),
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
