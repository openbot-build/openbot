import { Bots, Delegations, Execution } from "@openbot-build/domain"
import { Cause, Effect, Option, Schema } from "effect"
import { Tool } from "effect/ai"
import type { Entry } from "../apps/WorkflowTools.ts"
import type { Definition } from "../chats/ToolDefinitions.ts"
import { CallContext } from "../execution/CallContext.ts"
import type { Fence } from "../execution/Store.ts"
import * as Recovery from "../execution/Recovery.ts"
import { Records, category } from "../errors/Records.ts"
import { InputState, Local } from "../plugins/ToolEntry.ts"
import { json } from "../apps/AppResults.ts"
import { DelegationCommands } from "./DelegationCommands.ts"

export const names = {
	delegate: "openbot_delegate",
	cancel: "openbot_cancel_delegation",
} as const
export const Delegate = Schema.Struct({
	bot: Schema.optionalKey(Bots.BotId),
	task: Schema.NonEmptyString.check(Schema.isMaxLength(20000)),
	reason: Schema.optionalKey(Schema.String),
	delegation: Schema.optionalKey(Delegations.DelegationId),
	limits: Delegations.DelegationLimits,
})
export const Cancel = Schema.Struct({ delegation: Delegations.DelegationId })
const State = Schema.Struct({
	kind: Schema.Literals(["delegate", "cancel-delegation"]),
})

/** Saved tools submit commands. They do not own the task or its approval wait. */
export const make = Effect.gen(function* () {
	const commands = yield* DelegationCommands
	const errors = yield* Records
	const recovery = yield* Recovery.make
	const run =
		(fence: Fence, kind: (typeof State.Type)["kind"]): Entry["handle"] =>
		(raw, context) =>
			recovery
				.storage(
					fence.id,
					Effect.gen(function* () {
						const call = yield* CallContext
						if (
							context.toolCallId === undefined ||
							call.fence.id !== fence.id ||
							call.fence.namespace !== fence.namespace ||
							call.fence.generation !== fence.generation
						)
							return yield* Execution.Conflict.make({ id: fence.id })
						const site = Execution.mainCall(context.toolCallId)
						if (kind === "cancel-delegation") {
							const input = yield* Schema.decodeUnknownEffect(Cancel)(raw)
							return yield* json(
								yield* commands.cancel(fence, site, input.delegation),
							)
						}
						const input = yield* Schema.decodeUnknownEffect(Delegate)(raw)
						const receipt = yield* commands.submit(fence, site, {
							...(input.bot === undefined ? {} : { bot: input.bot }),
							task: input.task,
							reason: input.reason ?? "The Bot asks for help with its task.",
							limits: input.limits,
							...(input.delegation === undefined
								? {}
								: { previous: input.delegation }),
						})
						const key = { namespace: fence.namespace, id: receipt.executionId }
						const saved = yield* commands.load(key)
						yield* commands.authorize(
							key,
							saved.execution.identity.actor,
							"replay",
						)
						const view = yield* commands.view(key)
						return yield* json({
							delegation: view.delegation.id,
							executionId: key.id,
							status: view.delegation.status,
							executionStatus: view.status,
							note: "The work runs on its own. Its result returns to this Chat. Go on with other work, or end your answer now.",
						})
					}),
				)
				.pipe(
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.interrupt
							: errors.record(cause, category(cause), fence.id).pipe(
									Effect.map((failure) => ({ failure })),
									Effect.orDie,
								),
					),
				)
	const entries = (fence: Fence): ReadonlyArray<Entry> => [
		{
			tool: Tool.dynamic(names.delegate, {
				description:
					"Give a task to a Bot. Leave out bot to use yourself in a new Chat. Give a delegation id to add work to that task. Include all needed facts in task. The call returns at once; the saved workflow handles approval and limits. Its result returns to this Chat.",
				parameters: Schema.toJsonSchemaDocument(Delegate).schema,
				success: Schema.Json,
			})
				.addDependency(CallContext)
				.annotate(Local, true)
				.annotate(InputState, { kind: "delegate" }),
			handle: run(fence, "delegate"),
		},
		{
			tool: Tool.dynamic(names.cancel, {
				description:
					"Ask a delegation from this Chat and its child work to stop. An accepted request does not mean that the work has stopped.",
				parameters: Schema.toJsonSchemaDocument(Cancel).schema,
				success: Schema.Json,
			})
				.addDependency(CallContext)
				.annotate(Local, true)
				.annotate(InputState, { kind: "cancel-delegation" }),
			handle: run(fence, "cancel-delegation"),
		},
	]
	const restore = (
		fence: Fence,
		definition: Definition,
	): Option.Option<Entry> => {
		const state = definition.inputState
		if (!Schema.is(State)(state)) return Option.none()
		return Option.some({
			tool: Tool.dynamic(definition.name, {
				parameters: definition.parameters,
				success: Schema.Json,
			})
				.addDependency(CallContext)
				.annotate(Local, true)
				.annotate(InputState, state),
			handle: run(fence, state.kind),
		})
	}
	return { entries, restore }
})
