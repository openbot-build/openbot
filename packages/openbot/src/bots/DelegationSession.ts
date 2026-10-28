import {
	type Bots as BotsType,
	type ChatModelInvalid,
	Execution,
} from "@openbot-build/domain"
import type { Chat, ChatStore, Config } from "@openbot-build/core"
import { type Schema, Context, Effect, Layer } from "effect"
import type { SecretStorageError } from "../secrets/Secrets.ts"
import { type Failure, Bots } from "./Bots.ts"
import * as PolicyOrigin from "../capabilities/PolicyOrigin.ts"
import * as Gate from "../capabilities/Gate.ts"
import { RequestCommands } from "../capabilities/RequestCommands.ts"
import * as CallFrame from "../chats/CallFrame.ts"
import { inExecution } from "../chats/ChatEncoding.ts"
import type { Fence } from "../execution/Store.ts"
import { DelegationCommands } from "./DelegationCommands.ts"

/** Approval waits hold no Chat runtime. A resumed start checks current rights. */
const advance = (fence: Fence) =>
	Effect.gen(function* () {
		const commands = yield* DelegationCommands
		const bots = yield* Bots
		const requests = yield* RequestCommands
		const frames = yield* CallFrame.make
		const saved = yield* commands.load(fence)
		yield* commands.authorize(fence, saved.execution.identity.actor, "advance")
		if (saved.input.source._tag === "Trigger") {
			yield* commands.phase(fence, "running")
			const task = yield* commands.start(fence)
			return {
				_tag: "Started",
				key: { namespace: fence.namespace, id: task.executionId },
			} as const
		}
		if (saved.input.source._tag !== "Tool")
			return yield* Execution.Forbidden.make({})
		const site = saved.input.source.site
		const frame = yield* frames.read(fence, site)
		const target = yield* bots.access(
			saved.execution.identity.actor,
			saved.input.bot,
			"delegate",
		)
		if (target.archived) return yield* Execution.Forbidden.make({})
		const gate = yield* Gate.durable(
			fence,
			{
				identity: frame.identity,
				chat: frame.position.chat,
				turn: frame.position.turn,
			},
			"workflow",
		)
		const answer = yield* gate.check({
			capability: { action: "bots.delegate", target: target.id },
			reason: saved.input.reason,
			site,
			target,
			implicit:
				target.id === frame.bot ||
				(target.owner._tag === "Bot" && target.owner.bot === frame.bot),
		})
		if (answer._tag === "Deny") return yield* Execution.Forbidden.make({})
		if (answer._tag === "Pending") {
			if (answer.executionId === undefined)
				return yield* Execution.Conflict.make({ id: fence.id })
			const key = { namespace: fence.namespace, id: answer.executionId }
			const request = yield* requests.load(key)
			if (
				request.sourceKey.id !== fence.id ||
				request.continuation !== "workflow"
			)
				return yield* Execution.Forbidden.make({})
			if (!Execution.isTerminal(request.execution.record.status)) {
				yield* commands.phase(fence, "waiting")
				return { _tag: "Approval", key } as const
			}
			if (
				request.execution.record.status !== "completed" ||
				request.stored.request.status !== "allowed"
			)
				return yield* Execution.Forbidden.make({})
		}
		yield* commands.phase(fence, "running")
		const task = yield* commands.start(fence)
		return {
			_tag: "Started",
			key: { namespace: fence.namespace, id: task.executionId },
		} as const
	}).pipe(inExecution)

/** Each limit pause has one saved control operation, using the task Bot's policy. */
const continueWork = (fence: Fence) =>
	Effect.gen(function* () {
		const commands = yield* DelegationCommands
		const requests = yield* RequestCommands
		const origins = yield* PolicyOrigin.make
		const saved = yield* commands.load(fence)
		const stored = saved.stored
		if (
			stored.limitEpoch === undefined ||
			stored.limitTurnExecutionId === undefined
		)
			return yield* Execution.Conflict.make({ id: fence.id })
		const control: PolicyOrigin.Control = {
			kind: "delegationLimit",
			epoch: stored.limitEpoch,
			turnExecutionId: stored.limitTurnExecutionId,
		}
		if (stored.delegation.status === "running") {
			yield* commands.resume(fence, control)
			return { _tag: "Continued", epoch: control.epoch } as const
		}
		if (
			stored.delegation.status !== "paused" ||
			stored.delegation.pause === undefined
		)
			return yield* Execution.Conflict.make({ id: fence.id })
		const site = Execution.mainCall(PolicyOrigin.controlId(fence, control))
		const origin = yield* origins.read(fence, site, control)
		// The execution runs the policy check while the task itself stays paused.
		yield* commands.phase(fence, "running")
		const gate = yield* Gate.durable(
			fence,
			{
				identity: origin.identity,
				chat: origin.position.chat,
				turn: origin.position.turn,
			},
			"workflow",
			control,
		)
		const answer = yield* gate.check({
			capability: {
				action: "delegations.continue",
				target: stored.delegation.id,
				arguments: { limit: stored.delegation.pause.limit },
			},
			reason: `The work reached its ${stored.delegation.pause.limit} limit and asks to go on.`,
			site,
		})
		if (answer._tag === "Deny") {
			yield* commands.stopLimit(fence, control)
			return { _tag: "Stopped", epoch: control.epoch } as const
		}
		if (answer._tag === "Pending") {
			if (answer.executionId === undefined)
				return yield* Execution.Conflict.make({ id: fence.id })
			const key = { namespace: fence.namespace, id: answer.executionId }
			const request = yield* requests.load(key)
			if (
				request.sourceKey.id !== fence.id ||
				request.originKey.id !== control.turnExecutionId ||
				request.control?.epoch !== control.epoch ||
				request.continuation !== "workflow"
			)
				return yield* Execution.Forbidden.make({})
			if (!Execution.isTerminal(request.execution.record.status)) {
				yield* commands.phase(fence, "waiting")
				return { _tag: "Approval", key } as const
			}
			if (
				request.execution.record.status !== "completed" ||
				request.stored.request.status !== "allowed"
			)
				return yield* Execution.Forbidden.make({})
		}
		yield* commands.resume(fence, control)
		return { _tag: "Continued", epoch: control.epoch } as const
	}).pipe(inExecution)

export interface Service {
	readonly continueWork: (fence: Fence) => Effect.Effect<
		| {
				readonly key?: never
				readonly _tag: "Continued"
				readonly epoch: number
		  }
		| { readonly key?: never; readonly _tag: "Stopped"; readonly epoch: number }
		| {
				readonly epoch?: never
				readonly _tag: "Approval"
				readonly key: { namespace: string; id: Execution.Id }
		  },
		| BotsType.BotStorageUnavailable
		| Chat.ChatNotFound
		| ChatStore.ChatStoreError
		| Chat.Conflict
		| Execution.Conflict
		| Execution.KeyConflict
		| Schema.SchemaError
		| SecretStorageError
		| (Execution.Forbidden | Execution.NotFound | Execution.StorageError)
	>
	readonly advance: (fence: Fence) => Effect.Effect<
		| {
				readonly _tag: "Started"
				readonly key: { readonly namespace: string; readonly id: Execution.Id }
		  }
		| {
				readonly _tag: "Approval"
				readonly key: { namespace: string; id: Execution.Id }
		  },
		| ChatModelInvalid
		| Chat.ChatNotFound
		| ChatStore.ChatStoreError
		| Chat.Conflict
		| Execution.Conflict
		| Execution.KeyConflict
		| Config.ModelConfigurationError
		| Schema.SchemaError
		| SecretStorageError
		| Failure
		| (Execution.Forbidden | Execution.NotFound | Execution.StorageError)
	>
}

export class DelegationSession extends Context.Service<
	DelegationSession,
	Service
>()("@openbot-build/openbot/bots/DelegationSession") {}

const make = Effect.gen(function* () {
	const services =
		yield* Effect.context<
			Effect.Services<
				ReturnType<typeof advance> | ReturnType<typeof continueWork>
			>
		>()
	return DelegationSession.of({
		continueWork: (fence: Fence) =>
			continueWork(fence).pipe(Effect.provideContext(services)),
		advance: (fence: Fence) =>
			advance(fence).pipe(Effect.provideContext(services)),
	})
})

export const layer = Layer.effect(DelegationSession, make)
