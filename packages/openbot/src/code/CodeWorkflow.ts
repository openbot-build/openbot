import { Execution } from "@openbot-build/domain"
import { Effect, Layer, Option } from "effect"
import { workflowName as appWorkflow } from "../apps/AppCommands.ts"
import * as Children from "../execution/Children.ts"
import * as Engine from "../execution/Engine.ts"
import { Runner } from "../execution/Runner.ts"
import { RunScope } from "../execution/RunScope.ts"
import { Store, type Fence } from "../execution/Store.ts"
import { CodeCommands, workflowName } from "./CodeCommands.ts"
import { CodeProgram } from "./CodeProgram.ts"

export const workflow = Engine.define(workflowName)
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const commands = yield* CodeCommands
		const program = yield* CodeProgram
		const children = yield* Children.make
		const store = yield* Store
		const runner = yield* Runner
		const scopes = yield* RunScope
		const registry = yield* Engine.Registry
		const run = (fence: Fence, initialFailure?: Execution.Failure) =>
			Effect.gen(function* () {
				let failure = initialFailure
				while (true) {
					const state = yield* store.loadMember(fence)
					failure = (state.phaseFailed ? state.record.failure : null) ?? failure
					if (state.generation !== fence.generation)
						return yield* Effect.interrupt
					if (Execution.isTerminal(state.record.status)) return
					if (state.record.status === "cancelling") {
						yield* children.stop(fence, [appWorkflow])
						yield* commands.finish(fence, {
							status: "cancelled",
							epoch: state.cancelEpoch,
						})
						return
					}
					if (failure !== undefined) {
						yield* children.stop(fence, [appWorkflow])
						yield* commands.finish(fence, { status: "failed", failure })
						return
					}
					const saved = yield* commands.result(fence)
					if (Option.isSome(saved)) {
						yield* commands.authorize(fence, state.identity.actor, "replay")
						if (saved.value._tag === "Failed")
							yield* children.stop(fence, [appWorkflow])
						yield* commands.phase(fence, "running")
						yield* commands.finish(
							fence,
							saved.value._tag === "Completed"
								? { status: "completed" }
								: { status: "failed", failure: saved.value.failure },
						)
						return
					}
					const result = yield* scopes.run(
						fence,
						"program",
						program.run(fence).pipe(Effect.asVoid),
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
							commands.admit,
						),
					),
				),
			)
	}),
)
