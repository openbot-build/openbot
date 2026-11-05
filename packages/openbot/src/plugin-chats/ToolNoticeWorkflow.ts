import { Effect, Layer } from "effect"
import * as Engine from "@openbot-build/server-execution/execution/Engine"
import {
	Policy,
	Workflows,
} from "@openbot-build/server-execution/execution/Workflows"
import { Runner } from "@openbot-build/server-execution/execution/Runner"
import { Store } from "@openbot-build/server-execution/execution/Store"
import { noticeWorkflowName } from "./ToolCommands.ts"
import { ToolNotices } from "./ToolNotices.ts"

export const workflow = Engine.define(noticeWorkflowName)
/** Adds the workflow and its access rules. When the scope closes, they go. */
export const contribute = Effect.gen(function* () {
	const store = yield* Store
	const notices = yield* ToolNotices
	const runner = yield* Runner
	const workflows = yield* Workflows
	yield* workflows.contribute({
		workflow,
		plugin: "chats",
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
