import { Effect, Layer, Option, Stream } from "effect"
import { workflowName as requestWorkflow } from "../capabilities/RequestCommands.ts"
import * as Children from "../execution/Children.ts"
import * as Engine from "../execution/Engine.ts"
import { Observation } from "../execution/Observation.ts"
import * as Program from "../execution/Program.ts"
import type { Fence, Key } from "../execution/Store.ts"
import { AppCommands, inputDecision, workflowName } from "./AppCommands.ts"
import { AppSession } from "./AppSession.ts"

export const workflow = Engine.define(workflowName)
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const commands = yield* AppCommands
		const sessions = yield* AppSession
		const run = yield* Program.phased
		const registry = yield* Engine.Registry
		const observation = yield* Observation
		const wait = (key: Key) => observation.observe(key, 0).pipe(Stream.runDrain)
		const children = yield* Children.make
		const release = (fence: Fence) => children.stop(fence, [requestWorkflow])
		const next = Effect.fn("AppWorkflow.next")(function* ({
			fence,
		}: Program.Current) {
			const saved = yield* commands.load(fence)
			const phase = yield* commands.current(fence)
			if (phase._tag === "Done") {
				yield* commands.authorize(
					fence,
					saved.execution.identity.actor,
					"replay",
				)
				yield* commands.finish(
					fence,
					phase.result._tag === "Failed"
						? { status: "failed", failure: phase.result.failure }
						: { status: "completed" },
				)
				return { _tag: "Again" as const }
			}
			if (phase._tag === "Input") {
				if (!(yield* commands.waitInput(fence, phase.round)))
					return { _tag: "Again" as const }
				return {
					_tag: "Phase" as const,
					name: `input:${phase.round}`,
					work: undefined,
					options: { decisionId: inputDecision(phase.round) },
					after: Effect.void,
				}
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
			return {
				_tag: "Phase" as const,
				name: `send:${phase.input.round}:${attempt}`,
				work: Effect.gen(function* () {
					const session = yield* sessions.open(fence)
					while (true) {
						const permission = yield* session.permission
						if (permission._tag === "Ready") break
						yield* commands.phase(fence, "waiting")
						yield* wait(permission.key)
					}
					yield* commands.phase(fence, "running")
					yield* session.send
				}),
				options: undefined,
				after: Effect.void,
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
							commands.decide,
							commands.admit,
						),
					),
				),
			)
	}),
)
