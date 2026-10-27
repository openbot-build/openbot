import { Chat, Item, Store, Turn } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import { and, eq } from "drizzle-orm"
import { executions } from "../database/ExecutionSchema.ts"
import { databaseError } from "./ChatEncoding.ts"
import { Array as Arr, Effect, Option } from "effect"
import * as Db from "../database/Database.ts"
import * as ChatHost from "./ChatHost.ts"
import * as StoredChats from "./StoredChats.ts"
import { decode } from "./ChatEncoding.ts"
import * as Todos from "../plugins/work/Todos.ts"

const size = (limit: number | undefined) =>
	Math.max(1, Math.min(100, Math.floor(limit ?? 50)))
const page = <A, K>(
	rows: ReadonlyArray<A>,
	limit: number,
	key: (row: A) => K,
) => {
	const items = Arr.take(rows, limit)
	return {
		items,
		next:
			rows.length > limit
				? Option.getOrNull(Option.map(Arr.last(items), key))
				: null,
	}
}

/** Read saved Chat data. Opening a namespace creates no runtime or connection. */
export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const definition = yield* Store.define({
		stores: { [ChatHost.chatHostId]: ChatHost.chatHostStore, ...Todos.stores },
		schemaVersion: "chat/1",
	})
	return (namespace: string) => {
		const persistence = StoredChats.persistence(db, namespace)
		const read = (chat: Chat.Id) =>
			Effect.gen(function* () {
				const saved = yield* persistence.get(chat)
				if (Option.isNone(saved)) return yield* Chat.ChatNotFound.make({ chat })
				return {
					chat: yield* decode(definition.recordSchema)(saved.value.ref, chat),
					state: yield* decode(definition.schema)(saved.value.state, chat),
				}
			})
		const items = (
			chat: Chat.Id,
			query: Parameters<typeof persistence.items>[1],
		) =>
			persistence
				.items(chat, query)
				.pipe(
					Effect.flatMap((rows) =>
						Effect.forEach(rows, (row) => decode(Item.Record)(row, chat)),
					),
				)
		const findTurn = (chat: Chat.Id, turn: Turn.Id) =>
			persistence
				.turn(chat, turn)
				.pipe(
					Effect.flatMap((row) =>
						Effect.transposeOption(
							Option.map(row, (value) => decode(Turn.Record)(value, chat)),
						),
					),
				)
		const turn = (chat: Chat.Id, id: Turn.Id) =>
			Effect.gen(function* () {
				const view = yield* read(chat)
				const found =
					view.chat.turn?.id === id
						? Option.some(view.chat.turn)
						: yield* findTurn(chat, id)
				if (Option.isNone(found))
					return yield* Chat.Conflict.make({
						chat,
						message: "The Turn does not belong to this Chat",
					})
				return { view, record: found.value }
			})
		return {
			executionId: (turn: Turn.Id | undefined) =>
				turn === undefined
					? Effect.succeed(null)
					: db
							.select({ id: executions.id })
							.from(executions)
							.where(
								and(
									eq(executions.namespace, namespace),
									eq(executions.resourceKind, "Turn"),
									eq(executions.resourceId, turn),
								),
							)
							.limit(2)
							.pipe(
								Effect.mapError(databaseError),
								Effect.flatMap((rows) =>
									rows.length > 1
										? Effect.fail(
												databaseError("The Turn has more than one execution."),
											)
										: rows[0] === undefined
											? Effect.succeed(null)
											: decode(Execution.Id)(rows[0].id),
								),
							),
			read,
			turn,
			turns: (
				chat: Chat.Id,
				query: { readonly after?: Turn.Id; readonly limit?: number },
			) =>
				Effect.gen(function* () {
					yield* read(chat)
					if (
						query.after !== undefined &&
						Option.isNone(yield* findTurn(chat, query.after))
					)
						return yield* Chat.Conflict.make({
							chat,
							message: "The Turn cursor does not belong to this Chat",
						})
					const limit = size(query.limit)
					const rows = yield* persistence.turns(chat, {
						...query,
						limit: limit + 1,
					})
					const records = yield* Effect.forEach(rows, (row) =>
						decode(Turn.Record)(row, chat),
					)
					return page(records, limit, (record) => record.id)
				}),
			items: (
				chat: Chat.Id,
				query: { readonly before?: Item.Seq; readonly limit?: number },
			) =>
				Effect.gen(function* () {
					yield* read(chat)
					const limit = size(query.limit)
					return page(
						yield* items(chat, { ...query, limit: limit + 1, order: "desc" }),
						limit,
						(item) => item.seq,
					)
				}),
			turnItems: (
				chat: Chat.Id,
				id: Turn.Id,
				query: { readonly after?: Item.Id; readonly limit?: number },
			) =>
				Effect.gen(function* () {
					yield* turn(chat, id)
					const all = yield* items(chat, { turn: id })
					const after = query.after
					const start =
						after === undefined
							? Option.some(0)
							: Option.map(
									Arr.findFirstIndex(all, (entry) => entry.id === after),
									(index) => index + 1,
								)
					if (Option.isNone(start))
						return yield* Chat.Conflict.make({
							chat,
							message: "The Item cursor does not belong to this Turn",
						})
					return page(
						Arr.drop(all, start.value),
						size(query.limit),
						(item) => item.id,
					)
				}),
			turnLog: (chat: Chat.Id, id: Turn.Id) =>
				turn(chat, id).pipe(Effect.andThen(items(chat, { turn: id }))),
		}
	}
})
