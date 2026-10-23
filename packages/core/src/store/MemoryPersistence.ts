import { Chunk, Effect, HashMap, Option, SynchronizedRef } from "effect"
import type { Schema } from "effect"
import type * as Chat from "../chat/Chat.ts"
import type * as ChatStore from "./ChatStore.ts"
import { error } from "./StoreErrors.ts"

interface Stored {
	readonly ref: Schema.Json
	readonly state: Schema.Json
	readonly revision: number
	readonly items: Chunk.Chunk<ChatStore.StoredItem>
	readonly turns: Chunk.Chunk<{
		readonly id: string
		readonly value: Schema.Json
	}>
}

const range = (
	items: Chunk.Chunk<ChatStore.StoredItem>,
	query: ChatStore.ItemQuery,
) => {
	const selected = Chunk.toReadonlyArray(items).filter(
		(item) =>
			(query.turn === undefined || item.turn === query.turn) &&
			(query.after === undefined || item.seq > query.after) &&
			(query.before === undefined || item.seq < query.before),
	)
	const ordered = query.order === "desc" ? [...selected].reverse() : selected
	return query.limit === undefined ? ordered : ordered.slice(0, query.limit)
}

/** Adds a Turn record, or replaces the record with the same ID. */
const upsert = (
	turns: Stored["turns"],
	turn: ChatStore.Delta["turn"],
): Stored["turns"] =>
	turn === undefined
		? turns
		: Chunk.some(turns, (entry) => entry.id === turn.id)
			? Chunk.map(turns, (entry) => (entry.id === turn.id ? turn : entry))
			: Chunk.append(turns, turn)

/** Keeps Chats in memory. It is for tests and for programs that do not need a database. */
export const make: Effect.Effect<ChatStore.Persistence> = Effect.gen(
	function* () {
		const state = yield* SynchronizedRef.make({
			chats: HashMap.empty<string, Stored>(),
			order: Chunk.empty<string>(),
		})
		const find = (chat: Chat.Id) =>
			SynchronizedRef.get(state).pipe(
				Effect.map((s) => HashMap.get(s.chats, chat)),
			)
		const storage: ChatStore.Persistence = {
			get: (chat) =>
				find(chat).pipe(
					Effect.map(
						Option.map((stored) => ({ ref: stored.ref, state: stored.state })),
					),
				),
			list: SynchronizedRef.get(state).pipe(
				Effect.map((s) =>
					Chunk.toReadonlyArray(s.order).flatMap((id) =>
						Option.toArray(
							Option.map(HashMap.get(s.chats, id), (stored) => stored.ref),
						),
					),
				),
			),
			items: (chat, query) =>
				find(chat).pipe(
					Effect.map(
						Option.match({
							onNone: () => [],
							onSome: (stored) =>
								range(stored.items, query).map((item) => item.value),
						}),
					),
				),
			turns: (chat, query) =>
				find(chat).pipe(
					Effect.map(
						Option.match({
							onNone: () => [],
							onSome: (stored) => {
								const turns = Chunk.toReadonlyArray(stored.turns)
								const start =
									query.after === undefined
										? 0
										: turns.findIndex((turn) => turn.id === query.after) + 1
								const selected = turns.slice(start)
								return (
									query.limit === undefined
										? selected
										: selected.slice(0, query.limit)
								).map((turn) => turn.value)
							},
						}),
					),
				),
			turn: (chat, turn) =>
				find(chat).pipe(
					Effect.map((stored) =>
						Option.flatMap(stored, (stored) =>
							Option.map(
								Option.fromUndefinedOr(
									Chunk.toReadonlyArray(stored.turns).find(
										(entry) => entry.id === turn,
									),
								),
								(entry) => entry.value,
							),
						),
					),
				),
			save: (delta) =>
				SynchronizedRef.updateEffect(state, (s) =>
					Effect.gen(function* () {
						const current = HashMap.get(s.chats, delta.chat)
						const revision = Option.match(current, {
							onNone: () => null,
							onSome: (stored) => stored.revision,
						})
						if (revision !== delta.expected)
							return yield* error("reference-conflict", {
								message: "The Chat revision is out of date",
							})
						const before = Option.getOrUndefined(current)
						const turns = upsert(before?.turns ?? Chunk.empty(), delta.turn)
						const stored: Stored = {
							ref: delta.ref,
							state: delta.state ?? before?.state ?? null,
							revision: delta.revision,
							items: Chunk.appendAll(
								before?.items ?? Chunk.empty(),
								Chunk.fromIterable(delta.items),
							),
							turns,
						}
						return {
							chats: HashMap.set(s.chats, delta.chat, stored),
							order:
								before === undefined
									? Chunk.append(s.order, delta.chat)
									: s.order,
						}
					}),
				),
			remove: (chat) =>
				SynchronizedRef.update(state, (s) => ({
					chats: HashMap.remove(s.chats, chat),
					order: Chunk.filter(s.order, (id) => id !== chat),
				})),
		}
		return storage
	},
)
