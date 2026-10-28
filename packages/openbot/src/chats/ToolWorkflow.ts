import { workflowName as appWorkflow } from "../apps/AppCommands.ts"
import { workflowName as codeWorkflow } from "../code/CodeCommands.ts"
import { workflowName as requestWorkflow } from "../capabilities/RequestCommands.ts"
import * as Children from "../execution/Children.ts"
import { Clock, Effect, Layer, Option } from "effect"
import * as Engine from "../execution/Engine.ts"
import * as Program from "../execution/Program.ts"
import { Store, type Fence } from "../execution/Store.ts"
import { ToolCommands, workflowName } from "./ToolCommands.ts"
import { stepId } from "./ToolSteps.ts"
import { ToolSession } from "./ToolSession.ts"

export const workflow = Engine.define(workflowName)
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const store = yield* Store
		const commands = yield* ToolCommands
		const session = yield* ToolSession
		const run = yield* Program.phased
		const registry = yield* Engine.Registry
		const children = yield* Children.make
		const release = (fence: Fence) =>
			children.stop(fence, [appWorkflow, codeWorkflow, requestWorkflow])
		const next = Effect.fn("ToolWorkflow.next")(function* ({
			fence,
		}: Program.Current) {
			const saved = yield* commands.load(fence)
			const step = stepId(saved.record.position.item, saved.record.callId)
			const latest = yield* store.latestCall(fence, step)
			const completed = Option.exists(
				latest,
				(call) => call.status === "completed",
			)
			const remaining = saved.record.deadline - (yield* Clock.currentTimeMillis)
			if (remaining <= 0 && !completed) {
				yield* release(fence)
				yield* commands.finish(fence, { status: "interrupted" })
				return { _tag: "Again" as const }
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
			return {
				_tag: "Phase" as const,
				name: `${completed ? "result" : "attempt"}:${attempt}`,
				work: session.run(fence).pipe(
					Effect.asVoid,
					Effect.catchTag("ExecutionOutcomeUnknown", () => Effect.void),
				),
				options: completed ? undefined : { deadline: saved.record.deadline },
				after: Effect.gen(function* () {
					if (
						Option.exists(
							yield* store.latestCall(fence, step),
							(call) => call.status === "completed",
						)
					)
						yield* commands.finish(fence, { status: "completed" })
				}),
			}
		})
		const end = (fence: Fence, reason: Program.EndReason) =>
			release(fence).pipe(
				Effect.andThen(
					commands.finish(
						fence,
						reason._tag === "Cancel"
							? { status: "cancelled", epoch: reason.epoch }
							: reason._tag === "Fail"
								? { status: "failed", failure: reason.failure }
								: { status: "interrupted" },
					),
				),
				Effect.asVoid,
			)
		return workflow
			.toLayer((key) => run(key, { next, end }))
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
