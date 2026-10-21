import {
	Array as EffectArray,
	Effect,
	HashSet,
	Layer,
	Option,
	Record as EffectRecord,
} from "effect"
import { MemoryError, MemoryPolicy } from "./Memory.ts"

const union = <A>(a: ReadonlyArray<A>, b: ReadonlyArray<A>) =>
	EffectArray.dedupe([...a, ...b])
export const policy: typeof MemoryPolicy.Service = {
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
		Object.values(state.entries)
			.filter((entry) => entry.status === "active")
			.map(
				(entry) =>
					`[${entry.kind}; ${entry.key}; sources=${entry.sources.join(",")}] ${entry.content}`,
			)
			.join("\n"),
}
export const layer = Layer.succeed(MemoryPolicy, policy)
