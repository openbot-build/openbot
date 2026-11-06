import { Execution } from "@openbot-build/domain"
import { Records } from "@openbot-build/server-kernel/Records"
import { Array as Arr, Cause, Duration, Effect, HashMap, Stream } from "effect"
import { Observation } from "./Observation.ts"
import { Store, commandActor, type Fence, type Key } from "./Store.ts"
import { Workflows } from "./Workflows.ts"

/**
 * A child whose workflow is not on this server gets no command and cannot
 * end. The parent waits this long for the workflow to come back. Then it
 * stops waiting for that child.
 */
export const unhostedWait = Duration.seconds(30)

/** The parent's committed events name its children. Features choose which work they own. */
export const make = Effect.gen(function* () {
	const store = yield* Store
	const observation = yield* Observation
	const workflows = yield* Workflows
	const errors = yield* Records
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
	/** Ends when the workflow has not been on this server for `unhostedWait`. */
	const unhosted = (workflow: string) =>
		workflows.changes.pipe(
			Stream.map((current) => HashMap.has(current, workflow)),
			Stream.changes,
			Stream.switchMap((present) =>
				present ? Stream.never : Stream.fromEffect(Effect.sleep(unhostedWait)),
			),
			Stream.runHead,
		)
	/**
	 * Waits until the child ends. When its workflow is not on this server, the
	 * wait has a bound. The child keeps its state, because its outside work may
	 * still go on: it is not called cancelled. The parent keeps a record of the
	 * failure with the category `unavailable`, and goes on. Gives true when the
	 * child ended.
	 */
	const settle = (
		fence: Key,
		key: Key,
	): Effect.Effect<boolean, Execution.NotFound | Execution.StorageError> =>
		Effect.gen(function* () {
			const { workflow } = yield* store.load(key)
			const ended = yield* Effect.raceFirst(
				observation.observe(key, 0).pipe(Stream.runDrain, Effect.as(true)),
				Effect.as(unhosted(workflow), false),
			)
			if (ended) return true
			if (Execution.isTerminal((yield* store.get(key)).status)) return true
			return yield* workflows.require(workflow).pipe(
				Effect.matchEffect({
					// The workflow came back just now. Its child can end again.
					onSuccess: () => settle(fence, key),
					onFailure: (error) =>
						errors.record(Cause.fail(error), "unavailable", fence.id).pipe(
							Effect.tap(({ errorId }) =>
								Effect.logWarning(
									"A parent stopped waiting for a child whose workflow is not on this server.",
								).pipe(
									Effect.annotateLogs({
										parent: fence.id,
										child: key.id,
										workflow,
										feature: error.feature,
										errorId,
									}),
								),
							),
							Effect.as(false),
						),
				}),
			)
		})
	/** Gives the children that did not end, because their workflow is not on this server. */
	const wait = (fence: Key, children: ReadonlyArray<Key>) =>
		Effect.forEach(children, (key) => settle(fence, key), {
			concurrency: "unbounded",
		}).pipe(
			Effect.map((ended) =>
				Arr.filter(children, (_, index) => ended[index] === false),
			),
		)
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
			return yield* wait(fence, children)
		})
	const stop = (fence: Fence, workflows: ReadonlyArray<string>) =>
		list(fence, workflows).pipe(
			Effect.flatMap((children) => release(fence, children)),
			Effect.asVoid,
		)
	/** A child may leave a notice in its final transaction. Include that work before ending. */
	const owned = (fence: Fence, cancel: boolean) =>
		Effect.gen(function* () {
			// Children whose workflow is not on this server. The loop does not wait for them again.
			let left: ReadonlyArray<Key> = []
			while (true) {
				const parent = yield* store.load(fence)
				if (
					parent.generation !== fence.generation ||
					Execution.isTerminal(parent.record.status)
				)
					return yield* Execution.Conflict.make({ id: fence.id })
				const children = Arr.filter(
					Arr.map(yield* store.owned(fence, true), (entry) => entry.key),
					(key) => !Arr.some(left, (other) => other.id === key.id),
				)
				if (children.length === 0) return
				left = Arr.appendAll(
					left,
					cancel
						? yield* release(fence, children)
						: yield* wait(fence, children),
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
