import { Chat } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import { Array as Arr, Cause, Effect, Layer, Schema, Stream } from "effect"
import { Records } from "../errors/Records.ts"
import * as CallRecovery from "../execution/CallRecovery.ts"
import * as Engine from "../execution/Engine.ts"
import { Observation } from "../execution/Observation.ts"
import { Runner } from "../execution/Runner.ts"
import { RunScope } from "../execution/RunScope.ts"
import { Store, type Fence } from "../execution/Store.ts"
import { InputCommands, workflowName } from "./InputCommands.ts"
import { ToolCommands } from "./ToolCommands.ts"
import { TurnAccess } from "./TurnAccess.ts"
import { TurnSession } from "./TurnSession.ts"

export const workflow = Engine.define(workflowName)
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const store = yield* Store
		const settle = yield* CallRecovery.make
		const inputs = yield* InputCommands
		const tools = yield* ToolCommands
		const session = yield* TurnSession
		const scopes = yield* RunScope
		const runner = yield* Runner
		const errors = yield* Records
		const observation = yield* Observation
		const registry = yield* Engine.Registry
		const access = yield* TurnAccess
		const stopChildren = (fence: Fence) =>
			Effect.gen(function* () {
				const children = yield* tools.stopAttached(fence)
				yield* Effect.forEach(
					children,
					(child) =>
						Execution.isTerminal(child.status)
							? Effect.void
							: observation
									.observe(
										{
											namespace: fence.namespace,
											id: child.executionId,
										},
										0,
									)
									.pipe(Stream.runDrain),
					{ concurrency: "unbounded", discard: true },
				)
			})
		const run = (fence: Fence, initialFailure?: Execution.Failure) =>
			Effect.gen(function* () {
				const saved = yield* store.loadMember(fence)
				const { chat } = yield* Schema.decodeUnknownEffect(
					Schema.Struct({ chat: Chat.Id }),
				)(saved.input)
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
						yield* stopChildren(fence)
						yield* inputs.finish(fence, chat, {
							status: "cancelled",
							epoch: state.cancelEpoch,
						})
						continue
					}
					const history = yield* store.calls(fence)
					const latest = Arr.filter(
						history,
						(call) =>
							!Arr.some(
								history,
								(other) =>
									other.step === call.step && other.attempt > call.attempt,
							),
					)
					if (settled.stop) {
						yield* stopChildren(fence)
						const ended =
							failure ??
							(yield* errors.record(
								Cause.fail("The operator stopped an unknown tool call."),
								"interrupted",
								fence.id,
							))
						yield* inputs.finish(fence, chat, {
							status: "interrupted",
							failure: ended,
						})
						return
					}
					if (failure !== undefined) {
						yield* stopChildren(fence)
						yield* inputs.finish(fence, chat, { status: "failed", failure })
						return
					}
					// A decision or a late result changes this phase, while call IDs stay stable.
					const phase = Arr.join(
						Arr.map(latest, (call) => `${call.id}:${call.status}`),
						",",
					)
					const result = yield* scopes.run(
						fence,
						`turn:${phase}`,
						session
							.run(fence)
							.pipe(
								Effect.catchTag("ExecutionOutcomeUnknown", () => Effect.void),
							),
					)
					if (result._tag === "Cancelled") continue
					if (result._tag === "Failed") {
						failure = result.failure
						continue
					}
					const after = yield* store.calls(fence)
					if (
						Arr.some(
							after,
							(call) =>
								call.retry === "never" &&
								!Arr.some(
									after,
									(other) =>
										other.step === call.step && other.attempt > call.attempt,
								) &&
								(call.status === "sending" ||
									call.status === "outcome_unknown"),
						)
					)
						continue
					yield* inputs.finish(fence, chat, { status: "completed" })
					return
				}
			})
		return workflow
			.toLayer((key) => runner.run(key, (fence) => run(fence), run))
			.pipe(
				Layer.provideMerge(
					Layer.effectDiscard(
						registry.register(
							workflow,
							access.authorize,
							undefined,
							access.admit,
						),
					),
				),
			)
	}),
)
