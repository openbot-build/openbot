import { Effect, Layer, Option, Stream } from "effect"
import { workflowName as requestWorkflow } from "@openbot-build/conversation-contract/capabilities/RequestCommands"
import * as Children from "@openbot-build/server-execution/execution/Children"
import * as Engine from "@openbot-build/server-execution/execution/Engine"
import {
	Policy,
	Workflows,
} from "@openbot-build/server-execution/execution/Workflows"
import { Observation } from "@openbot-build/server-execution/execution/Observation"
import * as Program from "@openbot-build/server-execution/execution/Program"
import type {
	Fence,
	Key,
} from "@openbot-build/server-execution/execution/Store"
import {
	AppCommands,
	workflowName,
} from "@openbot-build/apps-contract/apps/AppCommands"
import { inputDecision } from "./AppCommands.ts"
import { AppSession } from "./AppSession.ts"

export const workflow = Engine.define(workflowName)
/** Adds the workflow and its access rules. When the scope closes, they go. */
export const contribute = Effect.gen(function* () {
	const commands = yield* AppCommands
	const sessions = yield* AppSession
	const run = yield* Program.phased
	const workflows = yield* Workflows
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
			yield* commands.authorize(fence, saved.execution.identity.actor, "replay")
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
	yield* workflows.contribute({
		workflow,
		plugin: "apps",
		journal: 1,
		run: (key) => run(key, { next, end }),
		policy: Policy.Public({
			authorize: commands.authorize,
			decide: commands.decide,
			admit: commands.admit,
		}),
	})
})

export const layer = Layer.effectDiscard(contribute)
