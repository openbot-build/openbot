import { Execution } from "@openbot-build/domain"
import { Clock, Effect, Layer, Option } from "effect"
import * as Engine from "../execution/Engine.ts"
import { Runner } from "../execution/Runner.ts"
import { RunScope } from "../execution/RunScope.ts"
import { type Fence } from "../execution/Store.ts"
import { RequestCommands, decisionId, workflowName } from "./RequestCommands.ts"
import { RequestReviews } from "./RequestReviews.ts"

export const workflow = Engine.define(workflowName)
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const commands = yield* RequestCommands
		const reviews = yield* RequestReviews
		const scopes = yield* RunScope
		const runner = yield* Runner
		const registry = yield* Engine.Registry
		const run = (fence: Fence, initialFailure?: Execution.Failure) =>
			Effect.gen(function* () {
				let failure = initialFailure
				while (true) {
					const { execution, stored } = yield* commands.load(fence)
					if (execution.generation !== fence.generation)
						return yield* Effect.interrupt
					if (Execution.isTerminal(execution.record.status)) return
					if (execution.record.status === "cancelling") {
						yield* reviews.release(fence)
						yield* commands.finish(fence, {
							status: "cancelled",
							epoch: execution.cancelEpoch,
						})
						return
					}
					if (failure !== undefined) {
						yield* reviews.release(fence)
						yield* commands.finish(fence, { status: "failed", failure })
						return
					}
					if (stored.request.status !== "pending") {
						yield* reviews.release(fence)
						yield* commands.finish(fence, { status: "completed" })
						return
					}
					if (stored.request.expiresAt <= (yield* Clock.currentTimeMillis)) {
						yield* commands.expire(fence)
						continue
					}
					yield* reviews.release(fence, stored.request.revision)
					yield* commands.authorize(fence, execution.identity.actor, "advance")
					const pending = yield* commands.waiting(fence)
					if (Option.isNone(pending)) continue
					const request = pending.value.request
					const review =
						request.approver._tag === "Bot"
							? yield* reviews.start(fence, request.revision)
							: Option.none()
					if (request.approver._tag === "Bot" && Option.isNone(review)) {
						yield* commands.pass(fence, request.revision)
						continue
					}
					// The start can race a decision. Read again before opening a wait.
					const waiting = yield* commands.waiting(fence)
					if (
						Option.isNone(waiting) ||
						waiting.value.request.revision !== request.revision
					)
						continue
					const work = Option.match(review, {
						onNone: () => undefined,
						onSome: (key) =>
							reviews
								.wait(key)
								.pipe(Effect.andThen(commands.pass(fence, request.revision))),
					})
					const result = yield* scopes.run(
						fence,
						`request:${request.revision}`,
						work,
						{
							deadline: request.expiresAt,
							decisionId: decisionId(request),
						},
					)
					if (result._tag === "Failed") failure = result.failure
				}
			})
		return workflow
			.toLayer((key) => runner.run(key, (fence) => run(fence), run))
			.pipe(
				Layer.provideMerge(
					Layer.effectDiscard(
						registry.register(workflow, commands.authorize, commands.decide),
					),
				),
			)
	}),
)
