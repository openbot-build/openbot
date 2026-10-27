import { Effect, Layer } from "effect"
import * as Engine from "../execution/Engine.ts"
import { Runner } from "../execution/Runner.ts"
import { Store } from "../execution/Store.ts"
import { noticeWorkflowName } from "./DelegationCommands.ts"
import { DelegationNotices } from "./DelegationNotices.ts"

export const workflow = Engine.define(noticeWorkflowName)
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const store = yield* Store
		const notices = yield* DelegationNotices
		const runner = yield* Runner
		const registry = yield* Engine.Registry
		return workflow
			.toLayer((key) =>
				runner.run(
					key,
					(fence) =>
						Effect.gen(function* () {
							const state = yield* store.loadMember(fence)
							if (state.record.status === "cancelling") {
								yield* notices.finish(fence, {
									status: "cancelled",
									epoch: state.cancelEpoch,
								})
								return
							}
							yield* notices.deliver(fence)
						}),
					(fence, failure) =>
						notices.finish(fence, { status: "failed", failure }),
				),
			)
			.pipe(
				Layer.provideMerge(
					Layer.effectDiscard(registry.register(workflow, notices.authorize)),
				),
			)
	}),
)
