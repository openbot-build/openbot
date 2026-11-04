import { Execution } from "@openbot-build/domain"
import { Array as Arr, Effect, HashSet, Stream } from "effect"
import { Observation } from "./Observation.ts"
import { Store, type Key } from "./Store.ts"

export interface Waiting {
	readonly path: ReadonlyArray<Execution.Id>
	readonly decisionId: string
}

/** A tool may yield its Turn while a saved child asks for a decision. */
export const make = Effect.gen(function* () {
	const observation = yield* Observation
	const follow = (
		key: Key,
		path: ReadonlyArray<Execution.Id>,
		seen: HashSet.HashSet<Execution.Id>,
	): Stream.Stream<Waiting, Execution.StorageError | Execution.NotFound> =>
		observation.observe(key, 0).pipe(
			Stream.flatMap(
				(event) => {
					if (event.body._tag === "DecisionNeeded")
						return Stream.succeed({ path, decisionId: event.body.decisionId })
					if (
						event.body._tag !== "ChildExecution" ||
						HashSet.has(seen, event.body.executionId)
					)
						return Stream.empty
					const id = event.body.executionId
					return follow(
						{ namespace: key.namespace, id },
						Arr.append(path, id),
						HashSet.add(seen, id),
					)
				},
				{ concurrency: "unbounded" },
			),
		)
	return (key: Key) => follow(key, [], HashSet.make(key.id))
})

/** The proof names immutable child events. Current decision state is checked at the commit. */
export const check = (store: Store["Service"], root: Key, waiting: Waiting) =>
	Effect.gen(function* () {
		let key = root
		for (const id of waiting.path) {
			let cursor = 0
			let found = false
			while (!found) {
				const events = yield* store.events(key, cursor)
				found = Arr.some(
					events,
					(event) =>
						event.body._tag === "ChildExecution" &&
						event.body.executionId === id,
				)
				if (events.length < 128) break
				if (Arr.isReadonlyArrayNonEmpty(events))
					cursor = Arr.lastNonEmpty(events).sequence
			}
			if (!found) return yield* Execution.Forbidden.make({})
			key = { namespace: root.namespace, id }
		}
		return yield* store.decisionPending(key, waiting.decisionId)
	})
