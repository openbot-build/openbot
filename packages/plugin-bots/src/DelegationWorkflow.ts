import { workflowName } from "@openbot-build/conversation-contract/bots/DelegationSource"
import { Array as Arr, Cause, Effect, Layer, Option, Stream } from "effect"
import { WorkAdmission } from "@openbot-build/conversation-contract/chats/WorkAdmission"
import { Calls } from "@openbot-build/server-execution/Calls"
import { Records } from "@openbot-build/server-kernel/Records"
import * as Children from "@openbot-build/server-execution/Children"
import * as Engine from "@openbot-build/server-execution/Engine"
import { Policy, Workflows } from "@openbot-build/server-execution/Workflows"
import { Observation } from "@openbot-build/server-execution/Observation"
import * as Program from "@openbot-build/server-execution/Program"
import {
	Store,
	type Fence,
	type Key,
} from "@openbot-build/server-execution/Store"
import { DelegationCommands } from "./DelegationCommands.ts"
import { DelegationSession } from "./DelegationSession.ts"

export const workflow = Engine.define(workflowName)
/** Adds the workflow and its access rules. When the scope closes, they go. */
export const contribute = Effect.gen(function* () {
	const commands = yield* DelegationCommands
	const admission = yield* WorkAdmission
	const calls = yield* Calls
	const sessions = yield* DelegationSession
	const store = yield* Store
	const run = yield* Program.phased
	const workflows = yield* Workflows
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
	yield* workflows.contribute({
		workflow,
		plugin: "bots",
		journal: 1,
		run: (key) => run(key, { next, end }),
		policy: Policy.Public({
			authorize: commands.authorize,
			decide: commands.decide,
			admit: admission.check,
		}),
	})
})

export const layer = Layer.effectDiscard(contribute)
