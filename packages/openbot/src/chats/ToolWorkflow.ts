import { workflowName as appWorkflow } from "../apps/AppCommands.ts"
import { workflowName as codeWorkflow } from "../code/CodeCommands.ts"
import { workflowName as requestWorkflow } from "../capabilities/RequestCommands.ts"
import * as Children from "../execution/Children.ts"
import { Execution } from "@openbot-build/domain"
import { Clock, Effect, Layer, Option } from "effect"
import * as CallRecovery from "../execution/CallRecovery.ts"
import * as Engine from "../execution/Engine.ts"
import { Runner } from "../execution/Runner.ts"
import { RunScope } from "../execution/RunScope.ts"
import { Store, type Fence } from "../execution/Store.ts"
import { ToolCommands, workflowName } from "./ToolCommands.ts"
import { latestCall } from "./ToolResults.ts"
import { ToolSession } from "./ToolSession.ts"

export const workflow = Engine.define(workflowName)
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const store = yield* Store
		const settle = yield* CallRecovery.make
		const scopes = yield* RunScope
		const commands = yield* ToolCommands
		const session = yield* ToolSession
		const runner = yield* Runner
		const registry = yield* Engine.Registry
		const children = yield* Children.make
		const release = (fence: Fence) =>
			children.stop(fence, [appWorkflow, codeWorkflow, requestWorkflow])
		const run = (fence: Fence, initialFailure?: Execution.Failure) =>
			Effect.gen(function* () {
				const saved = yield* commands.load(fence)
				let failure = initialFailure
				while (true) {
					const settled = yield* settle(fence, failure !== undefined)
					if (settled.restarted) failure = undefined
					const state = yield* store.loadMember(fence)
					failure = (state.phaseFailed ? state.record.failure : null) ?? failure
					if (state.generation !== fence.generation)
						return yield* Effect.interrupt
					if (Execution.isTerminal(state.record.status)) return
					if (state.record.status === "cancelling") {
						yield* release(fence)
						const ended = yield* commands.finish(fence, {
							status: "cancelled",
							epoch: state.cancelEpoch,
						})
						if (Execution.isTerminal(ended.status)) return
						continue
					}
					const history = yield* store.calls(fence)
					const latest = latestCall(saved.record, history)
					if (settled.stop) {
						yield* release(fence)
						yield* commands.finish(fence, { status: "interrupted" })
						return
					}
					if (failure !== undefined) {
						yield* release(fence)
						yield* commands.finish(fence, { status: "failed", failure })
						return
					}
					const completed = Option.exists(
						latest,
						(call) => call.status === "completed",
					)
					const remaining =
						saved.record.deadline - (yield* Clock.currentTimeMillis)
					if (remaining <= 0 && !completed) {
						yield* release(fence)
						yield* commands.finish(fence, { status: "interrupted" })
						return
					}
					const attempt = Option.match(latest, {
						onNone: () => 0,
						onSome: (call) =>
							call.attempt +
							(call.retry === "read_only" &&
							(call.status === "sending" || call.status === "outcome_unknown")
								? 1
								: 0),
					})
					const work = session.run(fence).pipe(
						Effect.asVoid,
						Effect.catchTag("ExecutionOutcomeUnknown", () => Effect.void),
					)
					const result = yield* scopes.run(
						fence,
						`${completed ? "result" : "attempt"}:${attempt}`,
						work,
						completed ? undefined : { deadline: saved.record.deadline },
					)
					if (result._tag === "Cancelled" || result._tag === "Expired") continue
					if (result._tag === "Failed") {
						failure = result.failure
						continue
					}
					const after = yield* store.calls(fence)
					if (
						Option.exists(
							latestCall(saved.record, after),
							(call) => call.status === "completed",
						)
					) {
						yield* commands.finish(fence, { status: "completed" })
						return
					}
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
							undefined,
							commands.admit,
						),
					),
				),
			)
	}),
)
