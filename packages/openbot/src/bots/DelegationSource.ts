import { Chat } from "@openbot-build/core"
import {
	Bots as BotDomain,
	Delegations as Domain,
	Caller,
	TriggerId,
	Triggers,
	Execution,
	keepsExecutionLimits,
} from "@openbot-build/domain"
import { Effect, HashSet, Option, Schema } from "effect"
import * as ToolOrigins from "../chats/ToolOrigins.ts"
import { Store, storage, type Key } from "../execution/Store.ts"
import { Delegations } from "./Delegations.ts"

export const workflowName = "openbot.delegation"
export const noticeWorkflowName = "openbot.delegation-notice"
export const Input = Schema.Struct({
	bot: BotDomain.BotId,
	task: Schema.NonEmptyString,
	reason: Schema.String,
	limits: Schema.optionalKey(Domain.DelegationLimits),
	previous: Schema.optionalKey(Domain.DelegationId),
})
export type Input = typeof Input.Type
export const Request = Schema.Struct({
	...Input.fields,
	bot: Schema.optionalKey(BotDomain.BotId),
})
export const Source = Schema.Union([
	Schema.TaggedStruct("Tool", { site: Execution.CallSite }),
	Schema.TaggedStruct("Trigger", {
		id: TriggerId,
		owner: Triggers.TriggerOwner,
		revision: Schema.Natural,
		chat: Chat.Id,
	}),
	Schema.TaggedStruct("Message", {
		previousExecutionId: Execution.Id,
		chat: Chat.Id,
		caller: Caller,
	}),
])
export const Saved = Schema.Struct({ ...Input.fields, source: Source })
export const codec = Schema.toCodecJson(Saved)
const sameCaller = Schema.toEquivalence(Caller)

/** A new message has its own source. The first tool remains part of its rights and notice history. */
export const make = Effect.gen(function* () {
	const store = yield* Store
	const origins = yield* ToolOrigins.make
	const delegations = yield* Delegations
	const read = Effect.fn("DelegationSource.read")(function* (key: Key) {
		const execution = yield* store.loadMember(key)
		const input = yield* Schema.decodeEffect(codec)(execution.input)
		const found = yield* delegations.find(
			execution.identity.owner.organizationId,
			execution.record.resource.id,
		)
		if (
			execution.workflow !== workflowName ||
			execution.record.resource.kind !== "Delegation" ||
			Option.isNone(found)
		)
			return yield* Execution.Forbidden.make({})
		const stored = found.value
		if (
			stored.executionId !== key.id ||
			stored.delegation.bot !== input.bot ||
			stored.userId !== execution.identity.owner.userId
		)
			return yield* Execution.Forbidden.make({})
		return { execution, input, stored }
	}, storage)
	return Effect.fn("DelegationSource.load")(function* (key: Key) {
		const saved = yield* read(key)
		let current = saved
		let sourceKey = key
		let seen = HashSet.make(key.id)
		while (current.input.source._tag === "Message") {
			const source = current.input.source
			if (HashSet.has(seen, source.previousExecutionId))
				return yield* Execution.Forbidden.make({})
			seen = HashSet.add(seen, source.previousExecutionId)
			sourceKey = { namespace: key.namespace, id: source.previousExecutionId }
			const previous = yield* read(sourceKey)
			if (
				!Execution.isTerminal(previous.execution.record.status) ||
				current.input.previous !== previous.stored.delegation.id ||
				source.chat !== previous.stored.delegation.chat ||
				source.chat !== current.stored.delegation.chat ||
				current.input.bot !== previous.input.bot ||
				current.execution.identity.owner.organizationId !==
					previous.execution.identity.owner.organizationId ||
				current.execution.identity.owner.userId !==
					previous.execution.identity.owner.userId ||
				!sameCaller(
					current.execution.identity.actor,
					previous.execution.identity.actor,
				) ||
				!keepsExecutionLimits(
					current.execution.identity,
					previous.execution.identity,
				) ||
				!keepsExecutionLimits(current.execution.identity, {
					...previous.execution.identity,
					constraints: [source.caller],
				})
			)
				return yield* Execution.Forbidden.make({})
			current = previous
		}
		if (current.input.source._tag === "Trigger") {
			const source = current.input.source
			for (const value of [saved, current]) {
				if (
					value.stored.delegation.trigger !== source.id ||
					value.stored.delegation.parent.chat !== source.chat ||
					value.stored.delegation.parent.turn !== undefined ||
					value.execution.identity.owner.userId !==
						value.execution.identity.actor.userId
				)
					return yield* Execution.Forbidden.make({})
			}
			return {
				...saved,
				origin: { _tag: "Trigger" as const, key: sourceKey, source },
			}
		}
		const origin = yield* origins.find(sourceKey)
		if (Option.isNone(origin)) return yield* Execution.Forbidden.make({})
		const position = origin.value.child.record.position
		for (const value of [saved, current]) {
			if (
				value.stored.delegation.parent.chat !== position.chat ||
				value.stored.delegation.parent.turn !== position.turn
			)
				return yield* Execution.Forbidden.make({})
		}
		if (
			current.input.source.site.main !== origin.value.child.record.callId ||
			!Schema.toEquivalence(Schema.Array(Schema.String))(
				current.input.source.site.path,
				origin.value.path,
			)
		)
			return yield* Execution.Forbidden.make({})
		return { ...saved, origin: { _tag: "Tool" as const, ...origin.value } }
	}, storage)
})
