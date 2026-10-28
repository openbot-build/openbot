import { Chat } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Effect,
	Layer,
	Option,
	Schema,
	Stream,
} from "effect"
import { Records } from "../errors/Records.ts"
import * as Engine from "../execution/Engine.ts"
import { Observation } from "../execution/Observation.ts"
import * as Program from "../execution/Program.ts"
import { Store, type Fence } from "../execution/Store.ts"
import { InputCommands, workflowName } from "./InputCommands.ts"
import { ToolCommands } from "./ToolCommands.ts"
import { TurnAccess } from "./TurnAccess.ts"
import { TurnSession } from "./TurnSession.ts"

export const workflow = Engine.define(workflowName)
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const store = yield* Store
		const inputs = yield* InputCommands
		const tools = yield* ToolCommands
		const session = yield* TurnSession
		const run = yield* Program.phased
		const errors = yield* Records
		const observation = yield* Observation
		const registry = yield* Engine.Registry
		const access = yield* TurnAccess
		const chatOf = (fence: Fence) =>
			store.loadMember(fence).pipe(
				Effect.flatMap((saved) =>
					Schema.decodeUnknownEffect(Schema.Struct({ chat: Chat.Id }))(
						saved.input,
					),
				),
				Effect.map((input) => input.chat),
			)
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
		const next = Effect.fn("TurnWorkflow.next")(function* ({
			fence,
		}: Program.Current) {
			const chat = yield* chatOf(fence)
			const latest = yield* store.latestCalls(fence)
			// A decision or a late result changes this phase, while call IDs stay stable.
			const phase = Arr.join(
				Arr.map(latest, (call) => `${call.id}:${call.status}`),
				",",
			)
			return {
				_tag: "Phase" as const,
				name: `turn:${phase}`,
				work: session
					.run(fence)
					.pipe(Effect.catchTag("ExecutionOutcomeUnknown", () => Effect.void)),
				options: undefined,
				after: Effect.gen(function* () {
					const after = yield* store.latestCalls(fence)
					if (
						Arr.some(
							after,
							(call) =>
								call.retry === "never" &&
								(call.status === "sending" ||
									call.status === "outcome_unknown"),
						)
					)
						return
					yield* inputs.finish(fence, chat, { status: "completed" })
				}),
			}
		})
		const end = Effect.fn("TurnWorkflow.end")(function* (
			fence: Fence,
			reason: Program.EndReason,
		) {
			const chat = yield* chatOf(fence)
			yield* stopChildren(fence)
			if (reason._tag === "Cancel") {
				yield* inputs.finish(fence, chat, {
					status: "cancelled",
					epoch: reason.epoch,
				})
				return
			}
			if (reason._tag === "Fail") {
				yield* inputs.finish(fence, chat, {
					status: "failed",
					failure: reason.failure,
				})
				return
			}
			const failure = yield* Option.match(reason.failure, {
				onNone: () =>
					errors.record(
						Cause.fail("The operator stopped an unknown tool call."),
						"interrupted",
						fence.id,
					),
				onSome: Effect.succeed,
			})
			yield* inputs.finish(fence, chat, { status: "interrupted", failure })
		})
		return workflow
			.toLayer((key) => run(key, { next, end }))
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
