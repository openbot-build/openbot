import { Array as Arr, Cause, Effect, Layer, Option, Stream } from "effect"
import { WorkAdmission } from "../chats/WorkAdmission.ts"
import { Calls } from "../execution/Calls.ts"
import { Records } from "../errors/Records.ts"
import * as Children from "../execution/Children.ts"
import * as Engine from "../execution/Engine.ts"
import { Observation } from "../execution/Observation.ts"
import * as Program from "../execution/Program.ts"
import { Store, type Fence, type Key } from "../execution/Store.ts"
import { DelegationCommands, workflowName } from "./DelegationCommands.ts"
import { DelegationSession } from "./DelegationSession.ts"

export const workflow = Engine.define(workflowName)
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const commands = yield* DelegationCommands
		const admission = yield* WorkAdmission
		const calls = yield* Calls
		const sessions = yield* DelegationSession
		const store = yield* Store
		const run = yield* Program.phased
		const registry = yield* Engine.Registry
		const observation = yield* Observation
		const errors = yield* Records
		const children = yield* Children.make
		const wait = (key: Key) => observation.observe(key, 0).pipe(Stream.runDrain)
		const release = (fence: Fence) =>
			commands.close(fence).pipe(Effect.andThen(children.stopOwned(fence)))
		const next = Effect.fn("DelegationWorkflow.next")(function* ({
			fence,
		}: Program.Current) {
			const saved = yield* commands.load(fence)
			const state = saved.execution
			yield* commands.authorize(fence, state.identity.actor, "advance")
			const domain = saved.stored.delegation.status
			if (domain === "authorizing" || domain === "paused")
				return {
					_tag: "Phase" as const,
					name: `${domain}:${saved.stored.limitEpoch ?? 0}:${state.record.sequence}`,
					work: Effect.gen(function* () {
						yield* calls.ready(fence)
						// Save the state change with the wait, so replay can advance the work.
						while (true) {
							const next = yield* domain === "authorizing"
								? sessions.advance(fence)
								: sessions.continueWork(fence)
							if (next._tag !== "Approval") break
							yield* wait(next.key)
						}
					}),
					options: undefined,
					after: Effect.void,
				}
			const next = yield* commands.inspect(fence)
			if (next._tag === "Changed") return { _tag: "Again" as const }
			if (next._tag === "Limit") {
				yield* commands.pause(fence, next.control)
				return { _tag: "Again" as const }
			}
			if (next._tag === "Ended") {
				if (Option.isNone(next.result)) {
					const task = yield* store.get(next.task)
					return {
						_tag: "Failed" as const,
						failure:
							task.failure ??
							(yield* errors.record(
								Cause.fail("The task ended without an answer."),
								"interrupted",
								fence.id,
							)),
					}
				}
				// A new input can follow inspect. Finish checks again under the Chat lock.
				yield* commands
					.finish(fence, { status: "completed", result: next.result.value })
					.pipe(Effect.catchTag("ExecutionConflict", () => Effect.void))
				return { _tag: "Again" as const }
			}
			const name = Arr.join(
				Arr.map(next.watch, (item) => `${item.key.id}:${item.sequence}`),
				",",
			)
			return {
				_tag: "Phase" as const,
				name: `task:${name}`,
				work: Effect.raceAllFirst(
					Arr.map(next.watch, (item) =>
						observation
							.observe(item.key, item.sequence)
							.pipe(Stream.take(1), Stream.runDrain),
					),
				),
				options:
					next.deadline === undefined ? undefined : { deadline: next.deadline },
				after: Effect.void,
			}
		})
		const end = Effect.fn("DelegationWorkflow.end")(function* (
			fence: Fence,
			reason: Program.EndReason,
		) {
			if (reason._tag === "Cancel") {
				yield* release(fence)
				yield* commands.finish(fence, {
					status: "cancelled",
					epoch: reason.epoch,
				})
				return
			}
			const failure =
				reason._tag === "Fail"
					? reason.failure
					: yield* Option.match(reason.failure, {
							onNone: () =>
								errors.record(
									Cause.fail("The operator stopped an unknown task call."),
									"interrupted",
									fence.id,
								),
							onSome: Effect.succeed,
						})
			yield* release(fence)
			yield* commands.finish(fence, { status: "failed", failure })
		})
		return workflow
			.toLayer((key) => run(key, { next, end }))
			.pipe(
				Layer.provideMerge(
					Layer.effectDiscard(
						registry.register(
							workflow,
							commands.authorize,
							commands.decide,
							admission.check,
						),
					),
				),
			)
	}),
)
