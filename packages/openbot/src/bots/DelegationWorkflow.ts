import { Execution } from "@openbot-build/domain"
import { Array as Arr, Cause, Effect, Layer, Option, Stream } from "effect"
import { WorkAdmission } from "../chats/WorkAdmission.ts"
import { Calls } from "../execution/Calls.ts"
import { Records } from "../errors/Records.ts"
import * as CallRecovery from "../execution/CallRecovery.ts"
import * as Children from "../execution/Children.ts"
import * as Engine from "../execution/Engine.ts"
import { Observation } from "../execution/Observation.ts"
import { Runner } from "../execution/Runner.ts"
import { RunScope } from "../execution/RunScope.ts"
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
		const scopes = yield* RunScope
		const runner = yield* Runner
		const registry = yield* Engine.Registry
		const observation = yield* Observation
		const errors = yield* Records
		const settle = yield* CallRecovery.make
		const children = yield* Children.make
		const wait = (key: Key) => observation.observe(key, 0).pipe(Stream.runDrain)
		const release = (fence: Fence) =>
			commands.close(fence).pipe(Effect.andThen(children.stopOwned(fence)))
		const run = (fence: Fence, initialFailure?: Execution.Failure) =>
			Effect.gen(function* () {
				let failure = initialFailure
				while (true) {
					const recovered = yield* settle(fence, failure !== undefined)
					if (recovered.restarted) failure = undefined
					const saved = yield* commands.load(fence)
					const state = saved.execution
					if (state.generation !== fence.generation)
						return yield* Effect.interrupt
					if (Execution.isTerminal(state.record.status)) return
					failure = (state.phaseFailed ? state.record.failure : null) ?? failure
					if (state.record.status === "cancelling") {
						yield* release(fence)
						yield* commands.finish(fence, {
							status: "cancelled",
							epoch: state.cancelEpoch,
						})
						continue
					}
					if (recovered.stop && failure === undefined)
						failure = yield* errors.record(
							Cause.fail("The operator stopped an unknown task call."),
							"interrupted",
							fence.id,
						)
					if (failure !== undefined) {
						yield* release(fence)
						yield* commands.finish(fence, { status: "failed", failure })
						return
					}
					yield* commands.authorize(fence, state.identity.actor, "advance")
					const domain = saved.stored.delegation.status
					if (domain === "authorizing" || domain === "paused") {
						const result = yield* scopes.run(
							fence,
							`${domain}:${saved.stored.limitEpoch ?? 0}:${state.record.sequence}`,
							Effect.gen(function* () {
								yield* calls.ready(fence)
								// A saved phase must include the state change after a decision.
								// Saving only the wait would replay Done without advancing the work.
								while (true) {
									const next = yield* domain === "authorizing"
										? sessions.advance(fence)
										: sessions.continueWork(fence)
									if (next._tag !== "Approval") break
									yield* wait(next.key)
								}
							}),
						)
						if (result._tag === "Failed") failure = result.failure
						continue
					}
					const next = yield* commands.inspect(fence)
					if (next._tag === "Changed") continue
					if (next._tag === "Limit") {
						yield* commands.pause(fence, next.control)
						continue
					}
					if (next._tag === "Ended") {
						if (Option.isNone(next.result)) {
							const task = yield* store.get(next.task)
							failure =
								task.failure ??
								(yield* errors.record(
									Cause.fail("The task ended without an answer."),
									"interrupted",
									fence.id,
								))
							continue
						}
						// New input or a notice can commit after inspect. Finish checks again under the Chat lock.
						const finished = yield* commands
							.finish(fence, { status: "completed", result: next.result.value })
							.pipe(
								Effect.as(true),
								Effect.catchTag("ExecutionConflict", () =>
									Effect.succeed(false),
								),
							)
						if (finished) return
						continue
					}
					const name = Arr.join(
						Arr.map(next.watch, (item) => `${item.key.id}:${item.sequence}`),
						",",
					)
					const changed = Effect.raceAllFirst(
						Arr.map(next.watch, (item) =>
							observation
								.observe(item.key, item.sequence)
								.pipe(Stream.take(1), Stream.runDrain),
						),
					)
					const result = yield* scopes.run(
						fence,
						`task:${name}`,
						changed,
						next.deadline === undefined
							? undefined
							: { deadline: next.deadline },
					)
					if (result._tag === "Failed") failure = result.failure
				}
			})
		return workflow
			.toLayer((key) => runner.run(key, (fence) => run(fence), run))
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
