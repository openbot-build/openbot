import { ChatStoreRepository, Store as CoreStore } from "@openbot-build/core"
import {
	Delegations as Domain,
	Execution,
	executionCallers,
	restrictExecution,
} from "@openbot-build/domain"
import { Clock, Crypto, Effect, Option, Schema } from "effect"
import * as Db from "../database/Database.ts"
import { Store } from "../execution/Store.ts"
import { Delegations } from "../bots/Delegations.ts"
import * as DelegationSource from "../bots/DelegationSource.ts"
import * as DelegationUsage from "../bots/DelegationUsage.ts"
import * as Todos from "../plugins/work/Todos.ts"
import * as ChatHost from "./ChatHost.ts"
import * as StoredChats from "./StoredChats.ts"
import { InputCommands, Message } from "./InputCommands.ts"
import { TurnAccess } from "./TurnAccess.ts"
import { inExecution } from "./ChatEncoding.ts"

/** Person input can start another round. The old execution and its outcome stay closed. */
export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const store = yield* Store
	const inputs = yield* InputCommands
	const access = yield* TurnAccess
	const sources = yield* DelegationSource.make
	const delegations = yield* Delegations
	const usage = yield* DelegationUsage.make
	const crypto = yield* Crypto.Crypto
	const definition = yield* CoreStore.define({
		stores: { [ChatHost.chatHostId]: ChatHost.chatHostStore, ...Todos.stores },
		schemaVersion: "chat/1",
	})
	const records = (namespace: string) =>
		ChatStoreRepository.make({
			definition,
			persistence: StoredChats.persistence(db, namespace),
		})
	const message = Effect.fn("TaskMessages.message")(
		function* (namespace: string, key: Execution.CommandKey, message: Message) {
			const chats = yield* records(namespace)
			const before = yield* chats.read(message.chat)
			yield* access.command(before.chat, message.caller)
			const body = yield* Schema.encodeEffect(Schema.toCodecJson(Message))(
				message,
			)
			const command = { actor: message.caller, body }
			const prior = yield* store.receipt(namespace, key, command)
			if (Option.isSome(prior)) return prior.value
			if (ChatHost.hostState(before.chat).kind !== "task")
				return yield* inputs.message(namespace, key, message)
			return yield* store.accept(namespace, key, command, () =>
				Effect.gen(function* () {
					yield* StoredChats.lock(db, namespace, message.chat)
					const view = yield* chats.read(message.chat)
					const host = ChatHost.hostState(view.chat)
					yield* access.command(view.chat, message.caller)
					if (host.ownerExecutionId === undefined || host.parent === undefined)
						return yield* Execution.Forbidden.make({})
					const previousKey = { namespace, id: host.ownerExecutionId }
					const previous = yield* sources(previousKey)
					if (
						previous.stored.delegation.chat !== message.chat ||
						previous.stored.delegation.id !== host.parent.delegation
					)
						return yield* Execution.Forbidden.make({})
					// Use another command key inside this transaction. The public key still names the returned Turn.
					const inputKey = Execution.CommandKey.make(
						yield* crypto.randomUUIDv4().pipe(Effect.orDie),
					)
					if (!Execution.isTerminal(previous.execution.record.status)) {
						const receipt = yield* inputs.message(namespace, inputKey, message)
						return { executionId: receipt.executionId, start: false }
					}
					const identity = restrictExecution(previous.execution.identity, [
						...(host.inputConstraints ?? []),
						message.caller,
					])
					yield* access.notice(view.chat, {
						...identity,
						botId: host.bot,
						delegationId: previous.stored.delegation.id,
						parentExecutionId: previous.origin.key.id,
					})
					const id = Domain.DelegationId.make(
						"dlg_" + (yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
					)
					// A new person command owns this round. It is not a child of the old, ended round.
					const receipt = yield* store.submit(
						namespace,
						Execution.CommandKey.make("delegation-message:" + id),
						{
							workflow: DelegationSource.workflowName,
							context: { kind: "Chat", id: message.chat },
							resource: { kind: "Delegation", id },
							identity,
							input: yield* Schema.encodeEffect(DelegationSource.codec)({
								bot: host.bot,
								task: "Continue with the new message.",
								reason: "The person added work to the task Chat.",
								previous: previous.stored.delegation.id,
								...(previous.input.limits === undefined
									? {}
									: { limits: previous.input.limits }),
								source: {
									_tag: "Message",
									previousExecutionId: previousKey.id,
									chat: message.chat,
									caller: message.caller,
								},
							}),
						},
					)
					const next = { namespace, id: receipt.executionId }
					yield* delegations.create(identity.owner.organizationId, {
						id,
						executionId: next.id,
						chat: message.chat,
						userId: identity.owner.userId,
						author: next.id,
						chain: previous.stored.chain,
						parent: previous.stored.delegation.parent,
						...(previous.stored.delegation.trigger === undefined
							? {}
							: { trigger: previous.stored.delegation.trigger }),
						bot: host.bot,
						task: "Continue with the new message.",
						reason: "The person added work to the task Chat.",
						...(previous.input.limits === undefined
							? {}
							: { limits: previous.input.limits }),
						status: "running",
					})
					yield* chats.modifyEffect({
						chat: message.chat,
						update: (view) =>
							Effect.succeed([
								undefined,
								Option.some({
									chat: {
										business: {
											...view.chat.business,
											[ChatHost.chatHostId]: {
												...host,
												ownerExecutionId: next.id,
												parent: { ...host.parent!, delegation: id },
												closed: false,
												inputConstraints: executionCallers(identity),
											},
										},
									},
								}),
							] as const),
					})
					yield* usage.begin(next, 0, yield* Clock.currentTimeMillis)
					const first = yield* store.accept(
						namespace,
						Execution.CommandKey.make("delegation-start:" + next.id),
						{
							actor: identity.actor,
							body: { delegationExecutionId: next.id },
						},
						() =>
							inputs
								.submit(namespace, inputKey, {
									chat: message.chat,
									identity: {
										...identity,
										botId: host.bot,
										delegationId: id,
										parentExecutionId: previous.origin.key.id,
									},
									content: message.content,
									queue: message.queue,
									...(message.notice === undefined
										? {}
										: { notice: message.notice }),
									...(message.action === undefined
										? {}
										: { action: message.action }),
									...(message.actionDefinition === undefined
										? {}
										: { actionDefinition: message.actionDefinition }),
								})
								.pipe(
									Effect.map((value) => ({
										executionId: value.executionId,
										start: false,
									})),
								),
					)
					return { executionId: first.executionId, start: false }
				}),
			)
		},
		Effect.scoped,
		inExecution,
	)
	return { message }
})
