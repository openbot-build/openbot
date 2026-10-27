import { Execution } from "@openbot-build/domain"
import { Array as Arr, Effect, Stream } from "effect"
import { Observation } from "./Observation.ts"
import { Store, commandActor, type Fence, type Key } from "./Store.ts"

/** The parent's committed events name its children. Features choose which work they own. */
export const make = Effect.gen(function* () {
	const store = yield* Store
	const observation = yield* Observation
	const list = (fence: Key, workflows: ReadonlyArray<string>) =>
		Effect.gen(function* () {
			let cursor = 0
			let children: ReadonlyArray<Key> = []
			while (true) {
				const events = yield* store.events(fence, cursor)
				for (const event of events) {
					if (event.body._tag !== "ChildExecution") continue
					const key = { namespace: fence.namespace, id: event.body.executionId }
					if (Arr.some(children, (child) => child.id === key.id)) continue
					if (Arr.contains(workflows, (yield* store.load(key)).workflow))
						children = Arr.append(children, key)
				}
				if (events.length < 128) return children
				if (Arr.isReadonlyArrayNonEmpty(events))
					cursor = Arr.lastNonEmpty(events).sequence
			}
		})
	const release = (fence: Fence, children: ReadonlyArray<Key>) =>
		Effect.gen(function* () {
			for (const key of children) {
				const child = yield* store.load(key)
				if (Execution.isTerminal(child.record.status)) continue
				yield* store
					.cancel(
						key,
						Execution.CommandKey.make(`release:${fence.id}:${key.id}`),
						commandActor(child.identity),
						Effect.gen(function* () {
							yield* store.guard(fence)
							const parent = yield* store.load(fence)
							if (
								parent.generation !== fence.generation ||
								Execution.isTerminal(parent.record.status)
							)
								return yield* Execution.Conflict.make({ id: fence.id })
						}),
					)
					.pipe(
						Effect.catchTag("ExecutionConflict", (error) =>
							store
								.get(key)
								.pipe(
									Effect.flatMap((state) =>
										Execution.isTerminal(state.status)
											? Effect.void
											: Effect.fail(error),
									),
								),
						),
					)
			}
			// Do not call a parent cancelled until all owned children have ended their scopes.
			yield* Effect.forEach(
				children,
				(key) => observation.observe(key, 0).pipe(Stream.runDrain),
				{ concurrency: "unbounded", discard: true },
			)
		})
	const stop = (fence: Fence, workflows: ReadonlyArray<string>) =>
		list(fence, workflows).pipe(
			Effect.flatMap((children) => release(fence, children)),
		)
	/** A child may leave a notice in its final transaction. Include that work before ending. */
	const owned = (fence: Fence, cancel: boolean) =>
		Effect.gen(function* () {
			while (true) {
				const parent = yield* store.load(fence)
				if (
					parent.generation !== fence.generation ||
					Execution.isTerminal(parent.record.status)
				)
					return yield* Execution.Conflict.make({ id: fence.id })
				const children = Arr.map(
					yield* store.owned(fence, true),
					(entry) => entry.key,
				)
				if (children.length === 0) return
				if (cancel) yield* release(fence, children)
				else
					yield* Effect.forEach(
						children,
						(key) => observation.observe(key, 0).pipe(Stream.runDrain),
						{
							concurrency: "unbounded",
							discard: true,
						},
					)
			}
		})
	return {
		list,
		stop,
		stopOwned: (fence: Fence) => owned(fence, true),
		waitOwned: (fence: Fence) => owned(fence, false),
	}
})
