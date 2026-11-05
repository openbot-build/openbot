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
import { Activity } from "effect/workflow"
import {
	BotFeatures,
	Pins,
} from "@openbot-build/conversation-contract/chats/BotFeatures"
import { Records } from "@openbot-build/server-kernel/errors/Records"
import * as Engine from "@openbot-build/server-execution/execution/Engine"
import {
	Policy,
	Workflows,
} from "@openbot-build/server-execution/execution/Workflows"
import { Observation } from "@openbot-build/server-execution/execution/Observation"
import * as Program from "@openbot-build/server-execution/execution/Program"
import {
	Store,
	type Fence,
} from "@openbot-build/server-execution/execution/Store"
import {
	InputCommands,
	workflowName,
} from "@openbot-build/conversation-contract/chats/InputCommands"
import { ToolCommands } from "@openbot-build/conversation-contract/chats/ToolCommands"
import { TurnAccess } from "@openbot-build/conversation-contract/chats/TurnAccess"
import { TurnSession } from "./TurnSession.ts"

export const workflow = Engine.define(workflowName)
/** Adds the workflow and its access rules. When the scope closes, they go. */
export const contribute = Effect.gen(function* () {
	const store = yield* Store
	const inputs = yield* InputCommands
	const tools = yield* ToolCommands
	const session = yield* TurnSession
	const run = yield* Program.phased
	const errors = yield* Records
	const observation = yield* Observation
	const workflows = yield* Workflows
	const access = yield* TurnAccess
	const features = yield* BotFeatures
	/**
	 * The first phase keeps the features of the Turn in the journal. Every later
	 * phase, and a replay on another node, reads the same list back.
	 */
	const pinned = Activity.make({
		name: "openbot/features",
		success: Pins,
		execute: features.snapshot,
	})
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
		const pins = yield* pinned
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
				.run(fence, pins)
				.pipe(Effect.catchTag("ExecutionOutcomeUnknown", () => Effect.void)),
			options: undefined,
			after: Effect.gen(function* () {
				const after = yield* store.latestCalls(fence)
				if (
					Arr.some(
						after,
						(call) =>
							call.retry === "never" &&
							(call.status === "sending" || call.status === "outcome_unknown"),
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
	yield* workflows.contribute({
		workflow,
		plugin: "chats",
		journal: 1,
		run: (key) => run(key, { next, end }),
		policy: Policy.Public({ authorize: access.authorize, admit: access.admit }),
	})
})

export const layer = Layer.effectDiscard(contribute)
