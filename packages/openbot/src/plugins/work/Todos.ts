import {
	type Chat,
	type ChatStore,
	type Plugin,
	Item,
	Turn,
} from "@openbot-build/core"
import { todoProblem, ChatTodos, type Todo } from "@openbot-build/domain"

import { Array as Arr, Effect, Option, pipe, Schema } from "effect"
import { Prompt } from "effect/ai"

/** The key of the todo list in the state of a Chat. */
export const storeKey = "@openbot-build/openbot/todos"
export const store = {
	scope: "state",
	schema: Schema.toCodecJson(ChatTodos),
} satisfies Plugin.StoreDefinition<
	ReturnType<typeof Schema.toCodecJson<typeof ChatTodos>>
>
const reminderKey = "@openbot-build/openbot/todo-reminders"
const ReminderState = Schema.Struct({
	turn: Turn.Id,
	lists: Schema.Array(ChatTodos.fields.items),
})
export const stores = {
	[storeKey]: store,
	[reminderKey]: { scope: "state", schema: Schema.toCodecJson(ReminderState) },
} satisfies Plugin.Stores
export type Values = {
	readonly [storeKey]?: ChatTodos
	readonly [reminderKey]?: typeof ReminderState.Type
}

export const empty: ChatTodos = { items: [] }

export const of = (view: Chat.View<Values>): ChatTodos =>
	view.state[storeKey] ?? empty

/** The items that are not done yet. While there are some, the Bot goes on working. */
export const open = (todos: ChatTodos): ReadonlyArray<Todo> =>
	Arr.filter(todos.items, (item) => item.status !== "done")

/** Why a list is not valid, or `undefined` when it is valid. */
export const problem = todoProblem

/** One line for each item, for the Bot to read. */
export const describe = (items: ReadonlyArray<Todo>): string =>
	pipe(
		items,
		Arr.map((item) => `- [${item.status}] ${item.id}: ${item.content}`),
		Arr.join("\n"),
	)

type Store<P extends Values> = Pick<ChatStore.Store<P>, "modifyEffect">

/** Replaces the list. With `revision`, the change fails when the Chat moved on. */
export const replace = <P extends Values>(input: {
	readonly store: Store<P>
	readonly chat: Chat.Id
	readonly items: ReadonlyArray<Todo>
	readonly revision?: Chat.Revision
}) =>
	Effect.gen(function* () {
		const reason = problem(input.items)
		if (reason !== undefined) return yield* Effect.die(reason)
		const changed = yield* input.store.modifyEffect({
			chat: input.chat,
			...(input.revision === undefined
				? {}
				: { expectedRevision: input.revision }),
			update: (current) =>
				Effect.succeed([
					undefined,
					Option.some({
						value: { ...current.state, [storeKey]: { items: input.items } },
					}),
				] as const),
		})
		return changed.view
	})

/**
 * A list where every item is done is old once its Turn ends, so it becomes empty.
 * It gives `undefined` when the list does not change.
 */
export const cleared = (todos: ChatTodos): ChatTodos | undefined =>
	todos.items.length > 0 && open(todos).length === 0 ? empty : undefined

/** Save a reminder and its key together. Recovery of a step cannot add it twice. */
export const continueTurn = <P extends Values>(input: {
	readonly store: Store<P>
	readonly chat: Chat.Id
	readonly turn: Turn.Id
	readonly item: Item.Id
	readonly allowReminder: boolean
	readonly message: (open: ReadonlyArray<Todo>) => string
}) =>
	input.store.modifyEffect({
		chat: input.chat,
		update: (current) =>
			Effect.gen(function* () {
				const turn = current.chat.turn
				if (turn?.id !== input.turn || turn.status._tag !== "Running")
					return [undefined, Option.none()] as const
				const todos = of(current)
				if (cleared(todos) !== undefined)
					return [
						undefined,
						Option.some({ value: { ...current.state, [storeKey]: empty } }),
					] as const
				const waiting = open(todos)
				if (!input.allowReminder || waiting.length === 0)
					return [undefined, Option.none()] as const
				const saved = current.state[reminderKey]
				const lists = saved?.turn === input.turn ? saved.lists : []
				const same = Schema.toEquivalence(ChatTodos.fields.items)
				if (Arr.some(lists, (items) => same(items, todos.items)))
					return [undefined, Option.none()] as const
				return [
					undefined,
					Option.some({
						value: {
							...current.state,
							[reminderKey]: {
								turn: input.turn,
								lists: Arr.append(lists, todos.items),
							},
						},
						chat: {
							inbox: Arr.append(current.chat.inbox, {
								id: input.item,
								kind: "steer" as const,
								turn: input.turn,
								content: Prompt.make([
									{ role: "user", content: input.message(waiting) },
								]),
								notice: { kind: "todos" },
								...(turn.author === undefined ? {} : { author: turn.author }),
							}),
						},
					}),
				] as const
			}),
	})
