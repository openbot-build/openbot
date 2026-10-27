import type { AppCalls } from "@openbot-build/domain"
import {
	Array as Arr,
	Order,
	String as Str,
	pipe,
	type JsonSchema,
} from "effect"

/** A saved binding description has no live client or action callback. */
export interface Binding {
	readonly name: string
	readonly source: AppCalls.Source
	readonly schema: JsonSchema.JsonSchema
	readonly description: string
	readonly needsDecision: boolean
	readonly readOnly: boolean
}

/** A binding with the name that programs use, such as `calendar.list_events`. */
export interface Named<A extends Binding = Binding> {
	readonly alias: string
	readonly binding: A
}

const slug = (text: string) => {
	const value = pipe(
		text,
		Str.toLowerCase,
		Str.replace(/[^a-z0-9]+/g, "_"),
		Str.replace(/^_+|_+$/g, ""),
	)
	return value.length === 0 || /^[0-9]/.test(value) ? "_" + value : value
}

/** Orders values by a text with `localeCompare`. */
const byText =
	<A>(text: (value: A) => string): Order.Order<A> =>
	(self, that) =>
		Str.localeCompare(text(that))(text(self))

const byConnection = byText((binding: Binding) => binding.source.connectionId)

/**
 * Gives each binding a short name. The first part names the connection, the second the
 * capability. The names depend only on the connections, so a new run gets the same names.
 */
export const name = <A extends Binding>(
	bindings: ReadonlyArray<A>,
): ReadonlyArray<Named<A>> => {
	const sorted = Arr.sort(
		bindings,
		Order.combineAll<A>([
			byConnection,
			byText((binding: Binding) => binding.source.kind),
			byText((binding: Binding) => binding.source.name),
		]),
	)
	// The first binding of a connection gives the name of the connection.
	const connections = pipe(
		bindings,
		Arr.dedupeWith((a, b) => a.source.connectionId === b.source.connectionId),
		Arr.sort(byConnection),
		Arr.map((binding) => binding.source),
	)
	let groups: ReadonlyArray<string> = []
	let named: ReadonlyArray<Named<A>> = []
	for (const connection of connections) {
		const base = slug(connection.connectionName)
		let group = base
		// `apps.call` is taken by the call that takes a full name.
		for (let n = 2; group === "call" || Arr.contains(groups, group); n++)
			group = base + "_" + n
		groups = [...groups, group]
		const own = Arr.filter(
			sorted,
			(binding) => binding.source.connectionId === connection.connectionId,
		)
		for (const binding of own) {
			const base =
				group +
				"." +
				slug(binding.source.name) +
				(binding.source.kind === "tool" ? "" : "_" + binding.source.kind)
			let alias = base
			for (let n = 2; Arr.some(named, (entry) => entry.alias === alias); n++)
				alias = base + "_" + n
			named = [...named, { alias, binding }]
		}
	}
	return named
}
