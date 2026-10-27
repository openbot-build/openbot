import { Execution } from "@openbot-build/domain"
import { Effect, Layer, Option, Stream } from "effect"
import { workflowName as requestWorkflow } from "../capabilities/RequestCommands.ts"
import * as Children from "../execution/Children.ts"
import * as CallRecovery from "../execution/CallRecovery.ts"
import * as Engine from "../execution/Engine.ts"
import { Observation } from "../execution/Observation.ts"
import { Runner } from "../execution/Runner.ts"
import { RunScope } from "../execution/RunScope.ts"
import type { Fence, Key } from "../execution/Store.ts"
import { AppCommands, inputDecision, workflowName } from "./AppCommands.ts"
import { AppSession } from "./AppSession.ts"

export const workflow = Engine.define(workflowName)
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const commands = yield* AppCommands
		const sessions = yield* AppSession
		const settle = yield* CallRecovery.make
		const scopes = yield* RunScope
		const runner = yield* Runner
		const registry = yield* Engine.Registry
		const observation = yield* Observation
		const wait = (key: Key) => observation.observe(key, 0).pipe(Stream.runDrain)
		const children = yield* Children.make
		const release = (fence: Fence) => children.stop(fence, [requestWorkflow])
		const run = (fence: Fence, initialFailure?: Execution.Failure) =>
			Effect.gen(function* () {
				let failure = initialFailure
				while (true) {
					const settled = yield* settle(fence, failure !== undefined)
					if (settled.restarted) failure = undefined
					const saved = yield* commands.load(fence)
					const state = saved.execution
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
					const phase = yield* commands.current(fence)
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
					if (phase._tag === "Done") {
						yield* commands.authorize(fence, state.identity.actor, "replay")
						yield* commands.finish(
							fence,
							phase.result._tag === "Failed"
								? { status: "failed", failure: phase.result.failure }
								: { status: "completed" },
						)
						return
					}
					if (phase._tag === "Input") {
						if (!(yield* commands.waitInput(fence, phase.round))) continue
						const waiting = yield* scopes.run(
							fence,
							`input:${phase.round}`,
							undefined,
							{ decisionId: inputDecision(phase.round) },
						)
						if (waiting._tag === "Failed") failure = waiting.failure
						continue
					}
					const attempt = Option.match(phase.call, {
						onNone: () => 0,
						onSome: (call) =>
							call.attempt +
							(call.retry === "read_only" &&
							(call.status === "sending" || call.status === "outcome_unknown")
								? 1
								: 0),
					})
					const work = Effect.gen(function* () {
						const session = yield* sessions.open(fence)
						while (true) {
							const permission = yield* session.permission
							if (permission._tag === "Ready") break
							yield* commands.phase(fence, "waiting")
							yield* wait(permission.key)
						}
						yield* commands.phase(fence, "running")
						yield* session.send
					})
					const result = yield* scopes.run(
						fence,
						`send:${phase.input.round}:${attempt}`,
						work,
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
