import type { Plugin, Session, SessionStore } from "@openbot-build/core"
import {
	SessionConflict,
	SessionTodos,
	type Todo,
	type UpdateTodosRequest,
} from "@openbot-build/api"
import { Effect, Option, Schema } from "effect"

/** The key of the todo list in the Timeline. A fork or a restore takes the list of that point. */
export const storeKey = "@openbot-build/openbot/todos"
export const store = {
	scope: "timeline",
	schema: Schema.toCodecJson(SessionTodos),
} satisfies Plugin.StoreDefinition<
	ReturnType<typeof Schema.toCodecJson<typeof SessionTodos>>
>
export const stores = { [storeKey]: store }
export type Values = { readonly [storeKey]?: SessionTodos }

export const empty: SessionTodos = { items: [] }

export const of = (view: Session.View<Values>): SessionTodos =>
	view.state.value[storeKey] ?? empty

/** The items that are not done yet. While there are some, the Agent goes on working. */
export const open = (todos: SessionTodos): ReadonlyArray<Todo> =>
	todos.items.filter((item) => item.status !== "done")

/** Why a list is not valid, or `undefined` when it is valid. */
export const problem = (items: ReadonlyArray<Todo>): string | undefined => {
	const ids = new Set(items.map((item) => item.id))
	if (ids.size !== items.length) return "Each todo needs its own id."
	if (items.filter((item) => item.status === "in_progress").length > 1)
		return "Only one todo can be in progress at a time."
	return undefined
}

/** One line for each item, for the Agent to read. */
export const describe = (items: ReadonlyArray<Todo>): string =>
	items
		.map((item) => `- [${item.status}] ${item.id}: ${item.content}`)
		.join("\n")

type Store<P extends Values> = Pick<SessionStore.Store<P>, "modifyEffect">

/** Replaces the list. With `base`, the change fails when the Session moved on. */
export const replace = <P extends Values>(input: {
	readonly store: Store<P>
	readonly session: Session.Id
	readonly items: ReadonlyArray<Todo>
	readonly base?: Pick<UpdateTodosRequest, "expected" | "revision">
}) =>
	Effect.gen(function* () {
		const reason = problem(input.items)
		if (reason !== undefined)
			return yield* SessionConflict.make({ message: reason })
		const changed = yield* input.store.modifyEffect({
			session: input.session,
			...(input.base === undefined
				? {}
				: {
						expectedHead: input.base.expected,
						expectedRevision: input.base.revision,
					}),
			update: (current) =>
				Effect.succeed([
					undefined,
					Option.some({
						value: {
							...current.state.value,
							[storeKey]: { items: input.items },
						},
					}),
				] as const),
		})
		return changed.view
	})
