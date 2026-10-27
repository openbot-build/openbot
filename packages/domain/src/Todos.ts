import { Array as Arr, HashSet, Schema } from "effect"

/** Where one item of a todo list is. */
export const TodoStatus = Schema.Literals(["pending", "in_progress", "done"])
export type TodoStatus = typeof TodoStatus.Type
/** One step of the work in a Chat. */
export const Todo = Schema.Struct({
	id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
	content: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
	status: TodoStatus,
})
export type Todo = typeof Todo.Type
/**
 * The todo list of a Chat. While an item is not done, the Bot goes on working.
 * When every item is done at the end of a Turn, the list becomes empty.
 */
export const ChatTodos = Schema.Struct({
	items: Schema.Array(Todo).check(Schema.isMaxLength(1000)),
})
export type ChatTodos = typeof ChatTodos.Type
/** Why a todo list is not valid, or undefined when it is valid. */
export const todoProblem = (items: ReadonlyArray<Todo>): string | undefined => {
	const ids = HashSet.fromIterable(Arr.map(items, (item) => item.id))
	if (HashSet.size(ids) !== items.length) return "Each todo needs its own id."
	if (Arr.filter(items, (item) => item.status === "in_progress").length > 1)
		return "Only one todo can be in progress at a time."
	return undefined
}
