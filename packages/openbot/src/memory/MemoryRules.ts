import {
	Array as EffectArray,
	Effect,
	HashSet,
	Layer,
	Option,
	Order,
	Record as EffectRecord,
} from "effect"
import { type Entry, MemoryError, MemoryPolicy } from "./Memory.ts"

/**
 * Adds the new values of `b` after `a`, in order. A HashSet finds the values that `a` has,
 * so a long list of processed Items stays fast. Only the short list `b` uses dedupe.
 */
const union = <A>(a: ReadonlyArray<A>, b: ReadonlyArray<A>) => {
	const seen = HashSet.fromIterable(a)
	return EffectArray.appendAll(
		a,
		EffectArray.dedupe(b.filter((value) => !HashSet.has(seen, value))),
	)
}
/** The default size limit of the memory text, in characters. */
export const defaultMaxLength = 8000

/**
 * The default rules. `maxLength` limits the memory text in the instructions.
 * The text starts with the newest active entry. It stops before the first entry that does not fit,
 * so all entries after that one are left out. An entry is never cut in the middle.
 */
export const make = (options: {
	readonly maxLength: number
}): typeof MemoryPolicy.Service => ({
	apply: (input) => {
		const allowed = HashSet.fromIterable(input.history.map((entry) => entry.id))
		const keys = input.changes.map((change) => change.key)
		if (
			EffectArray.dedupe(keys).length !== keys.length ||
			!input.changes.every(
				(change) =>
					change.sources.length > 0 &&
					change.sources.every((id) => HashSet.has(allowed, id)),
			)
		)
			return Effect.fail(
				new MemoryError({
					reason: "invalid-change",
					message:
						"Memory changes need unique keys and source messages from the given history",
				}),
			)
		// Keys are unique, so each change sees the entry from the given state.
		const entries = EffectArray.reduce(
			input.changes,
			input.state.entries,
			(entries, change) => {
				const previous = EffectRecord.get(entries, change.key)
				// Only a direct edit by the user can bring back a retracted entry.
				return change.status === "active" &&
					Option.exists(previous, (entry) => entry.status === "retracted")
					? entries
					: EffectRecord.set(entries, change.key, {
							...change,
							updatedAt: input.now,
							sources: union(
								Option.match(previous, {
									onNone: () => [],
									onSome: (entry) => entry.sources,
								}),
								change.sources,
							),
						})
			},
		)
		return Effect.succeed({
			...input.state,
			entries,
			processed: union(
				input.state.processed,
				input.history.map((entry) => entry.id),
			),
		})
	},
	project: (state) =>
		EffectArray.sort(
			Object.values(state.entries).filter((entry) => entry.status === "active"),
			Order.mapInput(
				Order.flip(Order.Number),
				(entry: Entry) => entry.updatedAt,
			),
		)
			.map(
				(entry) =>
					`[${entry.kind}; ${entry.key}; sources=${entry.sources.join(",")}] ${entry.content}`,
			)
			.reduce(
				(
					text: {
						readonly lines: ReadonlyArray<string>
						readonly full: boolean
					},
					line,
				) =>
					text.full
						? text
						: [...text.lines, line].join("\n").length <= options.maxLength
							? { lines: [...text.lines, line], full: false }
							: { ...text, full: true },
				{ lines: [], full: false },
			)
			.lines.join("\n"),
})
export const policy = make({ maxLength: defaultMaxLength })
export const layer = Layer.succeed(MemoryPolicy, policy)
