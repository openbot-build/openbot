import { Execution } from "@openbot-build/domain"
import { Effect, Layer, Option } from "effect"
import { workflowName as appWorkflow } from "@openbot-build/apps-contract/apps/AppCommands"
import * as Children from "@openbot-build/server-execution/execution/Children"
import * as Engine from "@openbot-build/server-execution/execution/Engine"
import {
	Policy,
	Workflows,
} from "@openbot-build/server-execution/execution/Workflows"
import { Runner } from "@openbot-build/server-execution/execution/Runner"
import { RunScope } from "@openbot-build/server-execution/execution/RunScope"
import {
	Store,
	type Fence,
} from "@openbot-build/server-execution/execution/Store"
import {
	CodeCommands,
	workflowName,
} from "@openbot-build/apps-contract/code/CodeCommands"
import { CodeProgram } from "./CodeProgram.ts"

export const workflow = Engine.define(workflowName)
/** Adds the workflow and its access rules. When the scope closes, they go. */
export const contribute = Effect.gen(function* () {
	const commands = yield* CodeCommands
	const program = yield* CodeProgram
	const children = yield* Children.make
	const store = yield* Store
	const runner = yield* Runner
	const scopes = yield* RunScope
	const workflows = yield* Workflows
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
	yield* workflows.contribute({
		workflow,
		plugin: "code",
		journal: 1,
		run: (key) => runner.run(key, (fence) => run(fence), run),
		policy: Policy.Public({
			authorize: commands.authorize,
			decide: commands.decide,
			admit: commands.admit,
		}),
	})
})

export const layer = Layer.effectDiscard(contribute)
