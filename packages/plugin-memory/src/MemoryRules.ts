import { Record as EffectRecord } from "effect"
import { Array as EffectArray, HashSet, Match, Effect, Layer } from "effect"
import { MemoryError, MemoryPolicy } from "./Memory.ts"

const union = <A>(a: ReadonlyArray<A>, b: ReadonlyArray<A>) =>
	EffectArray.dedupe([...a, ...b])
export const policy: typeof MemoryPolicy.Service = {
	apply: (input) =>
		Effect.gen(function* () {
			let entries = input.state.entries
			const allowed = HashSet.fromIterable(
				input.history.map((entry) => entry.id),
			)
			let changed = HashSet.empty<string>()
			for (const change of input.changes) {
				if (
					HashSet.has(changed, change.key) ||
					change.sources.length === 0 ||
					change.sources.some((id) => !HashSet.has(allowed, id))
				)
					return yield* new MemoryError({
						reason: "invalid-change",
						message:
							"Memory changes need unique keys and source messages from the given history",
					})
				changed = HashSet.add(changed, change.key)
				const previous = entries[change.key]
				Match.value({ previous, change }).pipe(
					Match.when(
						{ previous: { status: "retracted" }, change: { status: "active" } },
						() => {},
					),
					Match.orElse(() => {
						entries = EffectRecord.set(entries, change.key, {
							...change,
							updatedAt: input.now,
							sources: union(previous?.sources ?? [], change.sources),
						})
					}),
				)
			}
			return {
				...input.state,
				entries,
				processed: union(
					input.state.processed,
					input.history.map((entry) => entry.id),
				),
			}
		}),
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
