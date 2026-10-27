import { Chat, Turn } from "@openbot-build/core"
import {
	Caller,
	Execution,
	Requests,
	Delegations as Domain,
} from "@openbot-build/domain"
import { Effect, Option, Schema } from "effect"
import { Delegations } from "../bots/Delegations.ts"
import * as CallFrame from "../chats/CallFrame.ts"
import * as ChatHost from "../chats/ChatHost.ts"
import { TurnAccess } from "../chats/TurnAccess.ts"
import { Store, storage, type Fence, type Key } from "../execution/Store.ts"

/** A limit check is a control operation. It is not a model tool call. */
export const Control = Domain.LimitControl
export type Control = typeof Control.Type
export const controlId = (source: Key, control: Control) =>
	`delegation-limit:${source.id}:${control.epoch}`
const TurnReference = Schema.Struct({
	chat: Chat.Id,
	host: ChatHost.ChatHostState,
})
const sameCaller = Schema.toEquivalence(Caller)

export const make = Effect.gen(function* () {
	const store = yield* Store
	const frames = yield* CallFrame.make
	const delegations = yield* Delegations
	const access = yield* TurnAccess
	/** Historical requests keep their subject. Only a current pause can make a new check. */
	const limit = Effect.fn("PolicyOrigin.limit")(function* (
		sourceKey: Key,
		control: Control,
	) {
		const source = yield* store.loadMember(sourceKey)
		const originKey = {
			namespace: sourceKey.namespace,
			id: control.turnExecutionId,
		}
		const execution = yield* store.loadMember(originKey)
		const owner = yield* store.ownership(originKey)
		if (
			source.record.resource.kind !== "Delegation" ||
			source.workflow !== "openbot.delegation" ||
			execution.record.resource.kind !== "Turn" ||
			owner.ownerExecutionId !== sourceKey.id ||
			source.identity.owner.organizationId !==
				execution.identity.owner.organizationId ||
			source.identity.owner.userId !== execution.identity.owner.userId ||
			!sameCaller(source.identity.actor, execution.identity.actor)
		)
			return yield* Execution.Forbidden.make({})
		const reference = yield* Schema.decodeUnknownEffect(TurnReference)(
			execution.input,
		)
		const found = yield* delegations.find(
			source.identity.owner.organizationId,
			source.record.resource.id,
		)
		if (Option.isNone(found)) return yield* Execution.Forbidden.make({})
		const saved = found.value
		const host = reference.host
		if (
			saved.executionId !== sourceKey.id ||
			saved.userId !== execution.identity.owner.userId ||
			saved.delegation.chat !== reference.chat ||
			saved.delegation.bot !== execution.identity.botId ||
			host.kind !== "task" ||
			host.bot !== execution.identity.botId ||
			host.ownerExecutionId !== sourceKey.id ||
			host.parent?.delegation !== saved.delegation.id ||
			execution.identity.delegationId !== saved.delegation.id
		)
			return yield* Execution.Forbidden.make({})

		return {
			execution,
			originKey,
			limit: saved.delegation.pause?.limit,
			active:
				saved.delegation.status === "paused" &&
				saved.limitEpoch === control.epoch &&
				saved.limitTurnExecutionId === control.turnExecutionId &&
				saved.delegation.pause?.delegation === undefined,
			chat: reference.chat,
			turn: Turn.Id.make(execution.record.resource.id),
			host,
		}
	}, storage)
	const currentLimit = Effect.fn("PolicyOrigin.currentLimit")(function* (
		key: Key,
		control: Control,
	) {
		const origin = yield* limit(key, control)
		if (!origin.active) return yield* Execution.Conflict.make({ id: key.id })
		return origin
	})
	const read = Effect.fn("PolicyOrigin.read")(function* (
		fence: Fence,
		site: Execution.CallSite,
		control?: Control,
	) {
		if (control === undefined) {
			const frame = yield* frames.read(fence, site)
			return { ...frame, operation: [frame.position.item, ...frame.callPath] }
		}
		if (site.main !== controlId(fence, control) || site.path.length !== 0)
			return yield* Execution.Conflict.make({ id: fence.id })
		const origin = yield* currentLimit(fence, control)
		yield* access.authorize(
			origin.originKey,
			origin.execution.identity.actor,
			"replay",
		)
		return {
			identity: origin.execution.identity,
			bot: origin.host.bot,
			parent: origin.originKey.id,
			position: { chat: origin.chat, turn: origin.turn },
			host: origin.host,
			operation: ["delegationLimit", fence.id, String(control.epoch)],
			callPath: [],
			call: Option.none(),
			action: undefined,
		}
	}, storage)
	const linkRequest = Effect.fn("PolicyOrigin.linkRequest")(function* (
		fence: Fence,
		control: Control,
		request: Requests.CapabilityRequestId,
	) {
		const origin = yield* currentLimit(fence, control)
		yield* store.guard(fence)
		const changed = yield* delegations.change(
			origin.execution.identity.owner.organizationId,
			origin.execution.identity.delegationId!,
			["paused"],
			(saved) => ({
				...saved,
				delegation: {
					...saved.delegation,
					pause: { ...saved.delegation.pause!, request },
				},
			}),
			(saved) =>
				saved.limitEpoch === control.epoch &&
				saved.limitTurnExecutionId === control.turnExecutionId &&
				(saved.delegation.pause?.request === null ||
					saved.delegation.pause?.request === request),
		)
		if (Option.isNone(changed))
			return yield* Execution.Conflict.make({ id: fence.id })
	}, storage)
	return { limit, currentLimit, read, linkRequest }
})
