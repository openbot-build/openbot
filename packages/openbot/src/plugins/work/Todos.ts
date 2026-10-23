import type { Chat, ChatStore, Plugin } from "@openbot-build/core"
import { ChatConflict, ChatTodos, type Todo } from "@openbot-build/api"
import { Effect, Option, Schema } from "effect"

/** The key of the todo list in the state of a Chat. */
export const storeKey = "@openbot-build/openbot/todos"
export const store = {
	scope: "state",
	schema: Schema.toCodecJson(ChatTodos),
} satisfies Plugin.StoreDefinition<
	ReturnType<typeof Schema.toCodecJson<typeof ChatTodos>>
>
export const stores = { [storeKey]: store }
export type Values = { readonly [storeKey]?: ChatTodos }

export const empty: ChatTodos = { items: [] }

export const of = (view: Chat.View<Values>): ChatTodos =>
	view.state[storeKey] ?? empty

/** The items that are not done yet. While there are some, the Bot goes on working. */
export const open = (todos: ChatTodos): ReadonlyArray<Todo> =>
	todos.items.filter((item) => item.status !== "done")

/** Why a list is not valid, or `undefined` when it is valid. */
export const problem = (items: ReadonlyArray<Todo>): string | undefined => {
	const ids = new Set(items.map((item) => item.id))
	if (ids.size !== items.length) return "Each todo needs its own id."
	if (items.filter((item) => item.status === "in_progress").length > 1)
		return "Only one todo can be in progress at a time."
	return undefined
}

/** One line for each item, for the Bot to read. */
export const describe = (items: ReadonlyArray<Todo>): string =>
	items
		.map((item) => `- [${item.status}] ${item.id}: ${item.content}`)
		.join("\n")

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
		if (reason !== undefined)
			return yield* ChatConflict.make({ message: reason })
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
