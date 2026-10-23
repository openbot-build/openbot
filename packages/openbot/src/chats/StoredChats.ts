import { Chat, type ChatStore } from "@openbot-build/core"
import { Array, Clock, Effect, Option, Schema } from "effect"
import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	lt,
	or,
	sql,
} from "drizzle-orm"
import { chats, chatItems, chatTurns } from "../database/Schema.ts"
import * as Db from "../database/Database.ts"
import { chatHostId } from "./ChatHost.ts"
import { conflict, databaseError, decode } from "./ChatEncoding.ts"

/** The Chats of each namespace, kept in Postgres. */
type Database = Db.Database
const parse = decode(Schema.fromJsonString(Schema.Json))
const decodeRef = decode(Schema.fromJsonString(Chat.Ref))

/** The fields of a record that the table copies into its own columns. */
const Columns = Schema.Struct({
	createdAt: Schema.Finite,
	inbox: Schema.Array(Schema.Unknown),
	turn: Schema.optionalKey(
		Schema.Struct({
			id: Schema.String,
			status: Schema.Struct({ _tag: Schema.String }),
		}),
	),
	business: Schema.Struct({
		[chatHostId]: Schema.Struct({ bot: Schema.String, kind: Schema.String }),
	}),
})
const columnsOf = (ref: Schema.Json) =>
	Effect.gen(function* () {
		const record = yield* decode(Columns)(ref)
		const host = record.business[chatHostId]
		if (host === undefined) return yield* conflict()
		return {
			bot: host.bot,
			kind: host.kind,
			status: record.turn?.status._tag ?? "Idle",
			turn: record.turn?.id ?? null,
			inboxSize: record.inbox.length,
			createdAt: record.createdAt,
		}
	})

/** The core Chat store persistence of one namespace. */
export const persistence = (
	db: Database,
	namespace: string,
): ChatStore.Persistence => ({
	get: (chat) =>
		db
			.select({ body: chats.body, state: chats.state })
			.from(chats)
			.where(and(eq(chats.namespace, namespace), eq(chats.id, chat)))
			.pipe(
				Effect.map(Array.head),
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.succeedNone,
						onSome: (row) =>
							Effect.all({
								ref: parse(row.body),
								state: parse(row.state),
							}).pipe(Effect.asSome),
					}),
				),
				Effect.mapError(databaseError),
			),
	list: db
		.select({ body: chats.body })
		.from(chats)
		.where(eq(chats.namespace, namespace))
		.orderBy(asc(chats.createdAt), asc(chats.id))
		.pipe(
			Effect.flatMap((rows) => Effect.forEach(rows, (row) => parse(row.body))),
			Effect.mapError(databaseError),
		),
	items: (chat, query) =>
		db
			.select({ value: chatItems.value })
			.from(chatItems)
			.where(
				and(
					eq(chatItems.namespace, namespace),
					eq(chatItems.chat, chat),
					query.turn === undefined ? undefined : eq(chatItems.turn, query.turn),
					query.after === undefined
						? undefined
						: gt(chatItems.seq, query.after),
					query.before === undefined
						? undefined
						: lt(chatItems.seq, query.before),
				),
			)
			.orderBy(
				query.order === "desc" ? desc(chatItems.seq) : asc(chatItems.seq),
			)
			.limit(query.limit ?? Number.MAX_SAFE_INTEGER)
			.pipe(
				Effect.flatMap((rows) =>
					Effect.forEach(rows, (row) => parse(row.value)),
				),
				Effect.mapError(databaseError),
			),
	turns: (chat, query) =>
		Effect.gen(function* () {
			const after =
				query.after === undefined
					? undefined
					: (yield* db
							.select({ position: chatTurns.position })
							.from(chatTurns)
							.where(
								and(
									eq(chatTurns.namespace, namespace),
									eq(chatTurns.chat, chat),
									eq(chatTurns.id, query.after),
								),
							))[0]?.position
			if (query.after !== undefined && after === undefined) return []
			const rows = yield* db
				.select({ value: chatTurns.value })
				.from(chatTurns)
				.where(
					and(
						eq(chatTurns.namespace, namespace),
						eq(chatTurns.chat, chat),
						after === undefined ? undefined : gt(chatTurns.position, after),
					),
				)
				.orderBy(asc(chatTurns.position))
				.limit(query.limit ?? Number.MAX_SAFE_INTEGER)
			return yield* Effect.forEach(rows, (row) => parse(row.value))
		}).pipe(Effect.mapError(databaseError)),
	turn: (chat, turn) =>
		db
			.select({ value: chatTurns.value })
			.from(chatTurns)
			.where(
				and(
					eq(chatTurns.namespace, namespace),
					eq(chatTurns.chat, chat),
					eq(chatTurns.id, turn),
				),
			)
			.pipe(
				Effect.map(Array.head),
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.succeedNone,
						onSome: (row) => parse(row.value).pipe(Effect.asSome),
					}),
				),
				Effect.mapError(databaseError),
			),
	save: (delta) => save(db, namespace, delta),
	remove: (chat) => remove(db, namespace, chat),
})

/** Saves one change of a Chat in one transaction. An old revision fails with a conflict. */
export const save = (
	db: Database,
	namespace: string,
	delta: ChatStore.Delta,
): Effect.Effect<void, ChatStore.ChatStoreError> =>
	db
		.transaction((tx) =>
			Effect.gen(function* () {
				const columns = yield* columnsOf(delta.ref)
				const now = yield* Clock.currentTimeMillis
				const values = {
					body: JSON.stringify(delta.ref),
					bot: columns.bot,
					kind: columns.kind,
					status: columns.status,
					turn: columns.turn,
					revision: delta.revision,
					inboxSize: columns.inboxSize,
					// A change of a running Turn shows that its process still runs.
					runnerSeenAt: columns.status === "Running" ? now : null,
					updatedAt: now,
				}
				const written =
					delta.expected === null
						? yield* tx
								.insert(chats)
								.values({
									namespace,
									id: delta.chat,
									state: JSON.stringify(delta.state ?? null),
									createdAt: columns.createdAt,
									...values,
								})
								.onConflictDoNothing()
								.returning({ id: chats.id })
						: yield* tx
								.update(chats)
								.set({
									...values,
									...(delta.state === undefined
										? {}
										: { state: JSON.stringify(delta.state) }),
								})
								.where(
									and(
										eq(chats.namespace, namespace),
										eq(chats.id, delta.chat),
										eq(chats.revision, delta.expected),
									),
								)
								.returning({ id: chats.id })
				if (written.length !== 1) return yield* conflict()
				if (delta.items.length > 0)
					yield* tx.insert(chatItems).values(
						delta.items.map((item) => ({
							namespace,
							chat: delta.chat,
							seq: item.seq,
							id: item.id,
							turn: item.turn,
							value: JSON.stringify(item.value),
						})),
					)
				if (delta.turn !== undefined)
					yield* tx
						.insert(chatTurns)
						.values({
							namespace,
							chat: delta.chat,
							id: delta.turn.id,
							value: JSON.stringify(delta.turn.value),
						})
						.onConflictDoUpdate({
							target: [chatTurns.namespace, chatTurns.chat, chatTurns.id],
							set: { value: JSON.stringify(delta.turn.value) },
						})
			}),
		)
		.pipe(Effect.mapError(databaseError))

/** Deletes a Chat with its Items and Turns. */
export const remove = (
	db: Database,
	namespace: string,
	chat: Chat.Id,
): Effect.Effect<void, ChatStore.ChatStoreError> =>
	db
		.transaction((tx) =>
			Effect.gen(function* () {
				yield* tx
					.delete(chatItems)
					.where(
						and(eq(chatItems.namespace, namespace), eq(chatItems.chat, chat)),
					)
				yield* tx
					.delete(chatTurns)
					.where(
						and(eq(chatTurns.namespace, namespace), eq(chatTurns.chat, chat)),
					)
				yield* tx
					.delete(chats)
					.where(and(eq(chats.namespace, namespace), eq(chats.id, chat)))
			}),
		)
		.pipe(Effect.mapError(databaseError))

/** The records of the Chats of a namespace, oldest first. */
export const list = (
	db: Database,
	namespace: string,
	input: {
		readonly bot?: string
		readonly kinds?: ReadonlyArray<string>
	} = {},
): Effect.Effect<ReadonlyArray<Chat.Ref>, ChatStore.ChatStoreError> =>
	db
		.select({ body: chats.body })
		.from(chats)
		.where(
			and(
				eq(chats.namespace, namespace),
				input.bot === undefined ? undefined : eq(chats.bot, input.bot),
				input.kinds === undefined
					? undefined
					: inArray(chats.kind, [...input.kinds]),
			),
		)
		.orderBy(asc(chats.createdAt), asc(chats.id))
		.pipe(
			Effect.flatMap((rows) =>
				Effect.forEach(rows, (row) => decodeRef(row.body)),
			),
			Effect.mapError(databaseError),
		)

/** The ID of the direct Chat of a namespace with a Bot, when it has one. */
export const direct = (
	db: Database,
	namespace: string,
	bot: string,
): Effect.Effect<Option.Option<Chat.Id>, ChatStore.ChatStoreError> =>
	db
		.select({ id: chats.id })
		.from(chats)
		.where(
			and(
				eq(chats.namespace, namespace),
				eq(chats.bot, bot),
				eq(chats.kind, "direct"),
			),
		)
		.pipe(
			Effect.map((rows) =>
				Option.map(Array.head(rows), (row) => Chat.Id.make(row.id)),
			),
			Effect.mapError(databaseError),
		)

/** Shows that the running Turn of a Chat still runs on this server. */
export const heartbeat = (
	db: Database,
	namespace: string,
	chat: Chat.Id,
): Effect.Effect<void, ChatStore.ChatStoreError> =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis
		yield* db
			.update(chats)
			.set({ runnerSeenAt: now })
			.where(
				and(
					eq(chats.namespace, namespace),
					eq(chats.id, chat),
					eq(chats.status, "Running"),
				),
			)
	}).pipe(Effect.mapError(databaseError))

/** A Chat that needs the sweep: its body tells whose it is. */
export interface Swept {
	readonly namespace: string
	readonly id: Chat.Id
	readonly ref: Chat.Ref
}

/**
 * Chats in every namespace whose input waits while no Turn runs, and Chats whose
 * running Turn has not said that it runs since `staleBefore`.
 */
export const needingSweep = (
	db: Database,
	staleBefore: number,
): Effect.Effect<ReadonlyArray<Swept>, ChatStore.ChatStoreError> =>
	db
		.select({ namespace: chats.namespace, id: chats.id, body: chats.body })
		.from(chats)
		.where(
			or(
				and(gt(chats.inboxSize, 0), sql`${chats.status} <> 'Running'`),
				and(
					eq(chats.status, "Running"),
					or(isNull(chats.runnerSeenAt), lt(chats.runnerSeenAt, staleBefore)),
				),
			),
		)
		.limit(500)
		.pipe(
			Effect.flatMap((rows) =>
				Effect.forEach(rows, (row) =>
					decodeRef(row.body).pipe(
						Effect.map((ref) => ({
							namespace: row.namespace,
							id: Chat.Id.make(row.id),
							ref,
						})),
					),
				),
			),
			Effect.mapError(databaseError),
		)

/** The Chats of a namespace whose Turn says that it runs. */
export const running = (
	db: Database,
	namespace: string,
): Effect.Effect<ReadonlyArray<Chat.Id>, ChatStore.ChatStoreError> =>
	db
		.select({ id: chats.id })
		.from(chats)
		.where(and(eq(chats.namespace, namespace), eq(chats.status, "Running")))
		.pipe(
			Effect.map((rows) => rows.map((row) => Chat.Id.make(row.id))),
			Effect.mapError(databaseError),
		)
