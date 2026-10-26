import {
	Array as Arr,
	Chunk,
	Effect,
	HashMap,
	Option,
	SynchronizedRef,
} from "effect"
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
	const selected = Arr.filter(
		Chunk.toReadonlyArray(items),
		(item) =>
			(query.turn === undefined || item.turn === query.turn) &&
			(query.after === undefined || item.seq > query.after) &&
			(query.before === undefined || item.seq < query.before),
	)
	const ordered = query.order === "desc" ? Arr.reverse(selected) : selected
	return query.limit === undefined ? ordered : Arr.take(ordered, query.limit)
}

const empty: Pick<Stored, "state" | "items" | "turns"> = {
	state: null,
	items: Chunk.empty(),
	turns: Chunk.empty(),
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
					Arr.flatMap(Chunk.toReadonlyArray(s.order), (id) =>
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
								Arr.map(range(stored.items, query), (item) => item.value),
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
										: Option.match(
												Arr.findFirstIndex(
													turns,
													(turn) => turn.id === query.after,
												),
												{ onNone: () => 0, onSome: (index) => index + 1 },
											)
								const selected = Arr.drop(turns, start)
								return Arr.map(
									query.limit === undefined
										? selected
										: Arr.take(selected, query.limit),
									(turn) => turn.value,
								)
							},
						}),
					),
				),
			turn: (chat, turn) =>
				find(chat).pipe(
					Effect.map((stored) =>
						Option.flatMap(stored, (stored) =>
							Option.map(
								Arr.findFirst(stored.turns, (entry) => entry.id === turn),
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
						const before = Option.getOrElse(current, () => empty)
						const stored: Stored = {
							ref: delta.ref,
							state: delta.state ?? before.state,
							revision: delta.revision,
							items: Chunk.appendAll(
								before.items,
								Chunk.fromIterable(delta.items),
							),
							turns: upsert(before.turns, delta.turn),
						}
						return {
							chats: HashMap.set(s.chats, delta.chat, stored),
							order: Option.isNone(current)
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
