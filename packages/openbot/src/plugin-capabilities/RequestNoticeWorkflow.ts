import { Effect, Layer } from "effect"
import * as Engine from "../server-execution/execution/Engine.ts"
import { Policy, Workflows } from "../server-execution/execution/Workflows.ts"
import { Runner } from "../server-execution/execution/Runner.ts"
import { Store } from "../server-execution/execution/Store.ts"
import { noticeWorkflowName } from "./RequestCommands.ts"
import { RequestNotices } from "./RequestNotices.ts"

export const workflow = Engine.define(noticeWorkflowName)
/** Adds the workflow and its access rules. When the scope closes, they go. */
export const contribute = Effect.gen(function* () {
	const store = yield* Store
	const notices = yield* RequestNotices
	const runner = yield* Runner
	const workflows = yield* Workflows
	yield* workflows.contribute({
		workflow,
		plugin: "capabilities",
		journal: 1,
		run: (key) =>
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
		policy: Policy.Public({ authorize: notices.authorize }),
	})
})

export const layer = Layer.effectDiscard(contribute)
