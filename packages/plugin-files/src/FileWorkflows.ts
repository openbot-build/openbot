import * as RetryingCall from "@openbot-build/server-execution/RetryingCall"
import { Array as Arr, Clock, Effect, Layer, Option } from "effect"
import { Digest } from "effect/crypto"
import { DurableClock } from "effect/workflow"
import * as Engine from "@openbot-build/server-execution/Engine"
import { Policy, Workflows } from "@openbot-build/server-execution/Workflows"
import * as Program from "@openbot-build/server-execution/Program"
import { Store, type Fence } from "@openbot-build/server-execution/Store"
import {
	FileTasks,
	cleanupWorkflowName,
	retentionWorkflowName,
	serviceId,
} from "./FileTasks.ts"
import * as Objects from "./Objects.ts"

export const cleanup = Engine.define(cleanupWorkflowName)
export const retention = Engine.define(retentionWorkflowName)
/** Adds both workflows and their access rules, then starts the file tasks. */
export const contribute = Effect.gen(function* () {
	const tasks = yield* FileTasks
	const objects = yield* Objects.make
	const retry = yield* RetryingCall.make
	const store = yield* Store
	const workflows = yield* Workflows
	const run = yield* Program.make
	const remove = (fence: Fence) =>
		Effect.gen(function* () {
			const ref = yield* tasks.cleanup(fence)
			const objectKey = yield* tasks.objectKey(fence)
			const result = yield* retry(fence, "remove", { fileId: ref.fileId }, () =>
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
					const event = Arr.last(yield* store.events(fence, saved.sequence - 1))
					if (Option.isNone(event))
						return yield* Effect.die("The retention timer has no saved event.")
					yield* DurableClock.sleep({
						name: `collect:${saved.sequence}`,
						duration: Math.max(
							0,
							event.value.createdAt + 60000 - (yield* Clock.currentTimeMillis),
						),
						inMemoryThreshold: 0,
					})
					yield* store.commit(fence, { status: "running" }, Effect.void)
				}
				yield* tasks.authorizeRetention(fence)
				yield* store.commit(fence, { status: "waiting" }, tasks.collect)
			}
		})
	// The handlers get their services here, when the workflows are added.
	const digest = yield* Digest.Digest
	yield* workflows.contribute({
		workflow: cleanup,
		plugin: "files",
		journal: 1,
		run: (key) =>
			run(key, remove).pipe(Effect.provideService(Digest.Digest, digest)),
		policy: Policy.Service({ serviceId, authorize: tasks.authorizeCleanup }),
	})
	yield* workflows.contribute({
		workflow: retention,
		plugin: "files",
		journal: 1,
		run: (key) =>
			run(key, collect).pipe(Effect.provideService(Digest.Digest, digest)),
		policy: Policy.Service({ serviceId, authorize: tasks.authorizeRetention }),
	})
	yield* tasks.start
})

export const layer = Layer.effectDiscard(contribute)
