import * as RetryingCall from "../execution/RetryingCall.ts"
import { Array as Arr, Clock, Effect, Layer, Option } from "effect"
import { DurableClock } from "effect/workflow"
import * as Engine from "../execution/Engine.ts"
import * as Program from "../execution/Program.ts"
import { Store, type Fence } from "../execution/Store.ts"
import {
	FileTasks,
	cleanupWorkflowName,
	retentionWorkflowName,
	serviceId,
} from "./FileTasks.ts"
import * as Objects from "./Objects.ts"

export const cleanup = Engine.define(cleanupWorkflowName)
export const retention = Engine.define(retentionWorkflowName)
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const tasks = yield* FileTasks
		const objects = yield* Objects.make
		const retry = yield* RetryingCall.make
		const store = yield* Store
		const registry = yield* Engine.Registry
		const run = yield* Program.make
		const remove = (fence: Fence) =>
			Effect.gen(function* () {
				const ref = yield* tasks.cleanup(fence)
				const objectKey = yield* tasks.objectKey(fence)
				const result = yield* retry(
					fence,
					"remove",
					{ fileId: ref.fileId },
					() =>
						Effect.flatMap(Clock.currentTimeMillis, (now) =>
							objects.remove(objectKey, now),
						).pipe(Effect.timeout("30 seconds"), Effect.as(null)),
				)
				if (Option.isSome(result)) yield* tasks.complete(fence)
			})

		const collect = (fence: Fence) =>
			Effect.gen(function* () {
				while (true) {
					const saved = yield* store.get(fence)
					if (saved.status === "waiting") {
						// The event time survives owner changes; the row's updatedAt does not.
						const event = Arr.last(
							yield* store.events(fence, saved.sequence - 1),
						)
						if (Option.isNone(event))
							return yield* Effect.die(
								"The retention timer has no saved event.",
							)
						yield* DurableClock.sleep({
							name: `collect:${saved.sequence}`,
							duration: Math.max(
								0,
								event.value.createdAt +
									60000 -
									(yield* Clock.currentTimeMillis),
							),
							inMemoryThreshold: 0,
						})
						yield* store.commit(fence, { status: "running" }, Effect.void)
					}
					yield* tasks.authorizeRetention(fence)
					yield* store.commit(fence, { status: "waiting" }, tasks.collect)
				}
			})
		return Layer.mergeAll(
			cleanup.toLayer((key) => run(key, remove)),
			retention.toLayer((key) => run(key, collect)),
		).pipe(
			Layer.provideMerge(
				Layer.effectDiscard(
					Effect.gen(function* () {
						yield* registry.registerService(
							cleanup,
							serviceId,
							tasks.authorizeCleanup,
						)
						yield* registry.registerService(
							retention,
							serviceId,
							tasks.authorizeRetention,
						)
						yield* tasks.start
					}),
				),
			),
		)
	}),
)
