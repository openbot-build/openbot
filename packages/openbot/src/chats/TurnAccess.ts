import { triggerResource } from "../authorization/Resources.ts"
import { ownerKey } from "../apps/StoredConnections.ts"
import * as DelegationSource from "../bots/DelegationSource.ts"
import * as WorkAdmission from "./WorkAdmission.ts"
import * as ToolOrigins from "./ToolOrigins.ts"
import { Chat, type Config } from "@openbot-build/core"
import {
	Authorization,
	Bots as BotDomain,
	Caller,
	executionCallers,
	keepsExecutionLimits,
	Execution,
	type ExecutionIdentity,
} from "@openbot-build/domain"
import { Authorizer } from "@nmnmcc/ability"
import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	DateTime,
	Effect,
	HashSet,
	Layer,
	Option,
	Schema,
} from "effect"
import * as Check from "../authorization/Check.ts"
import { Tokens } from "../auth/Tokens.ts"
import { Bots } from "../bots/Bots.ts"
import { Delegations } from "../bots/Delegations.ts"
import { Requests } from "../capabilities/Requests.ts"
import { Channels } from "../channels/Channels.ts"
import * as Db from "../database/Database.ts"
import type { Authorize } from "../execution/Engine.ts"
import { Store, type Key } from "../execution/Store.ts"
import { Organization } from "../organization/Organization.ts"
import * as ChatHost from "./ChatHost.ts"
import * as StoredChats from "./StoredChats.ts"

const sameCaller = Schema.toEquivalence(Caller)
const payload = Schema.Struct({ chat: Chat.Id })
type Failure = Execution.Forbidden | Execution.NotFound | Execution.StorageError
const failures = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Failure, R> =>
	effect.pipe(
		Effect.catchCause((cause) => {
			const reason = cause.reasons[0]
			if (cause.reasons.length === 1 && reason?._tag === "Fail") {
				const error = reason.error
				if (
					Schema.is(Execution.Forbidden)(error) ||
					Schema.is(Execution.NotFound)(error) ||
					Schema.is(Execution.StorageError)(error)
				)
					return Effect.fail(error)
				if (
					Schema.is(Authorizer.Forbidden)(error) ||
					Schema.is(Authorizer.Pending)(error) ||
					Schema.is(BotDomain.BotNotFound)(error)
				)
					return Effect.fail(Execution.Forbidden.make({}))
			}
			if (Cause.hasInterruptsOnly(cause))
				return Effect.failCause(
					Cause.fromReasons(Arr.filter(cause.reasons, Cause.isInterruptReason)),
				)
			return Effect.fail(Execution.StorageError.make({ cause }))
		}),
	)

/** Turn commands and restored steps use the same current resource policy. */
const make = Effect.gen(function* () {
	const admission = yield* WorkAdmission.make
	const db = yield* Db.make
	const store = yield* Store
	const origins = yield* ToolOrigins.make
	const delegationSource = yield* DelegationSource.make
	const checks = yield* Check.make
	const bots = yield* Bots
	const channels = yield* Channels
	const organization = yield* Organization
	const tokens = yield* Tokens
	const delegations = yield* Delegations
	const requests = yield* Requests
	const active = Effect.fn(function* (organizationId: string, userId: string) {
		if (Option.isNone(yield* organization.activeMember(organizationId, userId)))
			return yield* Execution.Forbidden.make({})
	})
	const resource = (chat: Chat.Ref, identity: ExecutionIdentity) =>
		Authorization.Chat.make({
			organizationId: identity.owner.organizationId,
			ownerUserId: identity.owner.userId,
			id: chat.id,
		})
	const load = Effect.fn(function* (namespace: string, id: Chat.Id) {
		const found = yield* StoredChats.ref(db, namespace, id)
		if (Option.isNone(found)) return yield* Execution.Forbidden.make({})
		yield* Schema.decodeUnknownEffect(ChatHost.ChatHostState)(
			found.value.business[ChatHost.chatHostId],
		)
		return found.value
	})
	const inputFrom = (
		chat: Chat.Ref,
		identity: ExecutionIdentity,
		seen: HashSet.HashSet<Execution.Id>,
		current: boolean,
	): Effect.Effect<boolean, Failure> =>
		Effect.gen(function* () {
			yield* Schema.decodeUnknownEffect(ChatHost.ChatHostState)(
				chat.business[ChatHost.chatHostId],
			)
			if (!ChatHost.matchesIdentity(chat, identity))
				return yield* Execution.Forbidden.make({})
			const host = ChatHost.hostState(chat)
			if (current && host.control !== undefined)
				return yield* Execution.Forbidden.make({})
			let open = true
			const { owner, actor } = identity
			yield* active(owner.organizationId, owner.userId)
			for (const caller of executionCallers(identity)) {
				if (caller.organizationId !== owner.organizationId)
					return yield* Execution.Forbidden.make({})
				if (caller.userId !== owner.userId)
					yield* active(caller.organizationId, caller.userId)
				// Internal work and reviews keep every token that limits their source.
				if (caller.kind !== "user_token") continue
				const token = yield* tokens.find(caller, caller.tokenId)
				const now = yield* Clock.currentTimeMillis
				if (
					Option.isNone(token) ||
					(token.value.expiresAt !== null &&
						!Option.exists(
							DateTime.make(token.value.expiresAt),
							(expires) => DateTime.toEpochMillis(expires) > now,
						))
				)
					return yield* Execution.Forbidden.make({})
			}
			const parent = (expected: {
				readonly chat: Chat.Id
				readonly turn: string
				readonly owner: string
			}) =>
				Effect.gen(function* () {
					const id = identity.parentExecutionId
					if (id === undefined || HashSet.has(seen, id))
						return yield* Execution.Forbidden.make({})
					const key = yield* store.locate(id, owner.organizationId)
					const source = yield* store.loadMember(key)
					const origin = yield* origins.find(key)
					const linked = Option.isSome(origin)
						? origin.value
						: { key, execution: source }
					const record = linked.execution
					const reference = yield* Schema.decodeUnknownEffect(payload)(
						record.input,
					)
					if (
						record.record.resource.kind !== "Turn" ||
						record.record.resource.id !== expected.turn ||
						reference.chat !== expected.chat ||
						record.identity.owner.userId !== expected.owner ||
						!sameCaller(record.identity.actor, actor) ||
						!keepsExecutionLimits(identity, record.identity)
					)
						return yield* Execution.Forbidden.make({})
					yield* inputFrom(
						yield* load(key.namespace, reference.chat),
						record.identity,
						HashSet.add(HashSet.add(seen, id), linked.key.id),
						false,
					)
				})
			switch (host.kind) {
				case "channel": {
					if (host.channel === undefined)
						return yield* Execution.Forbidden.make({})
					const channel = yield* channels.get(
						owner.organizationId,
						host.channel.channel,
					)
					if (
						Option.isNone(channel) ||
						!channel.value.enabled ||
						channel.value.actor !== owner.userId ||
						channel.value.bot !== host.bot
					)
						return yield* Execution.Forbidden.make({})
					yield* Check.execution(checks, identity, {
						action: "use",
						resource: Authorization.Channel.make({
							organizationId: owner.organizationId,
							id: channel.value.id,
						}),
					})
					if (identity.channel?.id !== channel.value.id)
						return yield* Execution.Forbidden.make({})
					const linked = yield* channels.identity(
						channel.value.id,
						identity.channel.externalUserId,
					)
					if (Option.isNone(linked) || linked.value.userId !== actor.userId)
						return yield* Execution.Forbidden.make({})
					const authorities = Arr.filter(
						executionCallers(identity),
						(caller) => caller.userId === owner.userId,
					)
					if (authorities.length === 0)
						return yield* Execution.Forbidden.make({})
					for (const caller of authorities) {
						const bot = yield* bots.access(caller, host.bot, "delegate")
						if (bot.archived) return yield* Execution.Forbidden.make({})
					}
					return true
				}
				case "review": {
					if (
						host.review === undefined ||
						(current && host.closed === true) ||
						owner.userId !== actor.userId
					)
						return yield* Execution.Forbidden.make({})
					const saved = yield* requests.find(owner.organizationId, host.review)
					if (Option.isNone(saved)) return yield* Execution.Forbidden.make({})
					const { request, chain } = saved.value
					open =
						host.closed !== true &&
						request.status === "pending" &&
						request.expiresAt > (yield* Clock.currentTimeMillis) &&
						request.approver._tag === "Bot" &&
						request.approver.bot === host.bot
					if (
						(current &&
							(request.status !== "pending" ||
								request.expiresAt <= (yield* Clock.currentTimeMillis) ||
								request.approver._tag !== "Bot" ||
								request.approver.bot !== host.bot)) ||
						!Arr.contains(request.chain, host.bot) ||
						chain.userId !== actor.userId ||
						chain.tokenId !== actor.tokenId
					)
						return yield* Execution.Forbidden.make({})
					yield* parent({
						chat: request.chat,
						turn: request.turn,
						owner: ChatHost.ownerOf(chain),
					})
					const reviewer = yield* bots.find(owner.organizationId, host.bot)
					if (Option.isNone(reviewer) || reviewer.value.archived)
						return yield* Execution.Forbidden.make({})
					return open && host.control === undefined
				}
				case "task": {
					if (
						identity.delegationId === undefined ||
						(current && host.closed === true) ||
						(current && identity.delegationId !== host.parent?.delegation)
					)
						return yield* Execution.Forbidden.make({})
					const saved = yield* delegations.find(
						owner.organizationId,
						identity.delegationId,
					)
					if (Option.isNone(saved)) return yield* Execution.Forbidden.make({})
					const { delegation, chain, userId } = saved.value
					open =
						host.closed !== true &&
						identity.delegationId === host.parent?.delegation &&
						(delegation.status === "running" ||
							delegation.status === "queued" ||
							delegation.status === "paused")
					if (
						delegation.chat !== chat.id ||
						delegation.bot !== host.bot ||
						userId !== owner.userId ||
						chain.userId !== actor.userId ||
						chain.tokenId !== actor.tokenId ||
						(current &&
							delegation.status !== "running" &&
							delegation.status !== "queued" &&
							delegation.status !== "paused")
					)
						return yield* Execution.Forbidden.make({})
					if (delegation.parent.turn !== undefined)
						yield* parent({
							chat: delegation.parent.chat,
							turn: delegation.parent.turn,
							owner: owner.userId,
						})
					else {
						// A trigger has no parent Turn. It still works only in the owner's own Chats.
						if (
							actor.userId !== owner.userId ||
							delegation.trigger === undefined
						)
							return yield* Execution.Forbidden.make({})
						if (saved.value.executionId === undefined)
							return yield* Execution.Forbidden.make({})
						const source = yield* delegationSource({
							namespace: ownerKey(identity.owner),
							id: saved.value.executionId,
						})
						if (
							source.origin._tag !== "Trigger" ||
							identity.parentExecutionId !== source.origin.key.id ||
							!sameCaller(identity.actor, source.execution.identity.actor) ||
							!keepsExecutionLimits(identity, source.execution.identity)
						)
							return yield* Execution.Forbidden.make({})
						yield* Check.execution(checks, identity, {
							action: "read",
							resource: triggerResource({
								...source.origin.source,
								organizationId: owner.organizationId,
							}),
						})
						yield* inputFrom(
							yield* load(source.origin.key.namespace, delegation.parent.chat),
							source.execution.identity,
							HashSet.add(seen, source.origin.key.id),
							false,
						)
						yield* Check.execution(checks, identity, {
							action: "run",
							resource: resource(chat, identity),
						})
					}
					break
				}
				case "direct":
				case "live":
					yield* Check.execution(checks, identity, {
						action: "run",
						resource: resource(chat, identity),
					})
			}
			for (const caller of executionCallers(identity)) {
				const bot = yield* bots.access(caller, host.bot, "delegate")
				if (bot.archived) return yield* Execution.Forbidden.make({})
			}
			return open && host.control === undefined
		}).pipe(failures)
	const input = (chat: Chat.Ref, identity: ExecutionIdentity) =>
		inputFrom(chat, identity, HashSet.empty(), true).pipe(Effect.asVoid)
	const command = (chat: Chat.Ref, caller: Caller) =>
		Effect.gen(function* () {
			const host = ChatHost.hostState(chat)
			if (caller.organizationId !== host.chain.organizationId)
				return yield* Execution.Forbidden.make({})
			yield* active(caller.organizationId, caller.userId)
			yield* checks.check(caller, {
				action: "run",
				resource: Authorization.Chat.make({
					organizationId: host.chain.organizationId,
					ownerUserId: ChatHost.ownerOf(host.chain),
					id: chat.id,
				}),
			})
		}).pipe(Effect.asVoid, failures)
	const authorize: Authorize = (key, actor, access) =>
		Effect.gen(function* () {
			const execution = yield* store.loadMember(key)
			if (execution.record.resource.kind === "Delegation") {
				const source = yield* delegationSource(key)
				if (source.input.source._tag === "Trigger") {
					const chat = yield* load(key.namespace, source.input.source.chat)
					if (access === "advance" || access === "replay") {
						if (!sameCaller(actor, execution.identity.actor))
							return yield* Execution.Forbidden.make({})
						yield* Check.execution(checks, execution.identity, {
							action: "read",
							resource: triggerResource({
								...source.input.source,
								organizationId: execution.identity.owner.organizationId,
							}),
						})
						yield* inputFrom(
							chat,
							execution.identity,
							HashSet.make(key.id),
							false,
						)
					} else {
						yield* active(actor.organizationId, actor.userId)
						yield* checks.check(actor, {
							action: "read",
							resource: resource(chat, execution.identity),
						})
						if (access !== "read")
							yield* checks.check(actor, {
								action: "write",
								resource: resource(chat, execution.identity),
							})
						yield* checks.check(actor, {
							action: access === "read" ? "read" : "write",
							resource: triggerResource({
								...source.input.source,
								organizationId: execution.identity.owner.organizationId,
							}),
						})
					}
					return
				}
				if (source.input.source._tag === "Message") {
					const chat = yield* load(key.namespace, source.input.source.chat)
					if (access === "advance" || access === "replay") {
						if (!sameCaller(actor, execution.identity.actor))
							return yield* Execution.Forbidden.make({})
						yield* command(chat, source.input.source.caller)
						return yield* inputFrom(
							chat,
							{
								...execution.identity,
								botId: source.input.bot,
								delegationId: source.stored.delegation.id,
								parentExecutionId: source.origin.key.id,
							},
							HashSet.make(key.id),
							false,
						).pipe(Effect.asVoid)
					}
					// The new person command belongs to the task Chat.
					if (actor.organizationId !== execution.identity.owner.organizationId)
						return yield* Execution.Forbidden.make({})
					yield* active(actor.organizationId, actor.userId)
					yield* checks.check(actor, {
						action: "read",
						resource: resource(chat, execution.identity),
					})
					if (access !== "read")
						yield* checks.check(actor, {
							action: "write",
							resource: resource(chat, execution.identity),
						})
					return
				}
			}
			if (execution.record.resource.kind !== "Turn") {
				const origin = yield* origins.find(key)
				if (Option.isNone(origin)) return yield* Execution.Forbidden.make({})
				const parent = origin.value
				// A detached tool may continue after its Turn ends, with current member and token rights.
				return yield* authorize(
					parent.key,
					actor,
					access === "advance" ? "replay" : access,
				)
			}
			if (
				execution.record.resource.kind !== "Turn" ||
				actor.organizationId !== execution.identity.owner.organizationId
			)
				return yield* Execution.Forbidden.make({})
			const ref = yield* Schema.decodeUnknownEffect(payload)(execution.input)
			const chat = yield* load(key.namespace, ref.chat)
			if (!ChatHost.matchesIdentity(chat, execution.identity))
				return yield* Execution.Forbidden.make({})
			if (access === "advance" || access === "replay") {
				if (!sameCaller(actor, execution.identity.actor))
					return yield* Execution.Forbidden.make({})
				return yield* inputFrom(
					chat,
					execution.identity,
					HashSet.make(key.id),
					access === "advance",
				).pipe(Effect.asVoid)
			}
			yield* active(actor.organizationId, actor.userId)
			yield* checks.check(actor, {
				action: "read",
				resource: resource(chat, execution.identity),
			})
			if (access !== "read")
				yield* checks.check(actor, {
					action: "write",
					resource: resource(chat, execution.identity),
				})
		}).pipe(failures)
	return {
		admit: admission.check,
		input,
		/** The command caller needs their own right to add input to the saved Chat. */
		command,
		authorize,
		/** Check the selected model at each new send, including a summary. */
		model: (key: Key, selection: Config.Selection) =>
			Effect.gen(function* () {
				const { identity } = yield* store.loadMember(key)
				yield* authorize(key, identity.actor, "advance")
				yield* Check.model(checks, identity, selection)
			}).pipe(failures),
		notice: (chat: Chat.Ref, identity: ExecutionIdentity) =>
			inputFrom(chat, identity, HashSet.empty(), false),
	}
})
export class TurnAccess extends Context.Service<
	TurnAccess,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/chats/TurnAccess") {}
export const layer = Layer.effect(TurnAccess, make)
