import { randomUUID } from "node:crypto"
import { Chat, Turn } from "@openbot-build/core"
import { BotsApi, DelegationsApi } from "@openbot-build/api"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { hash } from "../capabilities/Capability.ts"
import { Chain } from "../chats/ChatHost.ts"
import { BotRecords } from "./BotRecords.ts"

type Delegation = DelegationsApi.Delegation

/**
 * A delegation as it is stored. `userId` is the member whose Chats hold the work.
 * `author` is who the work is for, so its result goes back to them. `chain` is the
 * work that gave it, and the work of the child goes on from there. `request` is the
 * request that decides whether the work may start.
 */
export const Stored = Schema.Struct({
	delegation: DelegationsApi.Delegation,
	userId: Schema.String,
	author: Turn.Author,
	chain: Chain,
	request: Schema.optionalKey(Schema.String),
})
export type Stored = typeof Stored.Type

export interface CreateInput {
	readonly userId: string
	readonly author: Turn.Author
	readonly chain: Chain
	readonly parent: Delegation["parent"]
	readonly trigger?: string
	readonly bot: BotsApi.BotId
	readonly task: string
	readonly reason?: string
	/** The task Chat of earlier work that this work goes on with. */
	readonly chat?: Chat.Id
	readonly status: "authorizing" | "queued" | "running" | "failed"
	readonly request?: string
	readonly result?: string
}

/** The records of work that one Bot gave to a Bot. */
export class Delegations extends Context.Service<
	Delegations,
	{
		/**
		 * Records a delegation. A tool call makes at most one: a second call for the
		 * same tool call returns the first.
		 */
		readonly create: (
			organizationId: string,
			input: CreateInput,
		) => Effect.Effect<Stored, BotsApi.BotStorageUnavailable>
		readonly find: (
			organizationId: string,
			id: string,
		) => Effect.Effect<Option.Option<Stored>, BotsApi.BotStorageUnavailable>
		/** The work that one Chat gave away. */
		readonly forChat: (
			organizationId: string,
			chat: Chat.Id,
		) => Effect.Effect<ReadonlyArray<Stored>, BotsApi.BotStorageUnavailable>
		/** The delegations of a member whose work happens in this Chat, newest last. */
		readonly forChild: (
			organizationId: string,
			userId: string,
			chat: Chat.Id,
		) => Effect.Effect<ReadonlyArray<Stored>, BotsApi.BotStorageUnavailable>
		/** The delegation that waits for a request, when one does. */
		readonly forRequest: (
			organizationId: string,
			chat: Chat.Id,
			request: string,
		) => Effect.Effect<Option.Option<Stored>, BotsApi.BotStorageUnavailable>
		/** Delegations that are not closed, in every organization. */
		readonly open: Effect.Effect<
			ReadonlyArray<{
				readonly organizationId: string
				readonly value: Stored
			}>,
			BotsApi.BotStorageUnavailable
		>
		/**
		 * Changes a delegation when it still has one of the expected statuses.
		 * Returns None when it does not, so two workers never do the same step.
		 */
		readonly change: (
			organizationId: string,
			id: string,
			expected: ReadonlyArray<Delegation["status"]>,
			update: (stored: Stored) => Stored,
		) => Effect.Effect<Option.Option<Stored>, BotsApi.BotStorageUnavailable>
	}
>()("@openbot-build/openbot/bots/Delegations") {}

/** True when the work has not ended yet. */
export const isOpen = (stored: Stored) =>
	DelegationsApi.OpenDelegationStatus.literals.some(
		(status) => status === stored.delegation.status,
	)

export const make: Effect.Effect<
	typeof Delegations.Service,
	never,
	BotRecords
> = Effect.gen(function* () {
	const records = yield* BotRecords
	const delegations = records.collection(
		"delegation",
		Stored,
		DelegationsApi.DelegationStatus,
	)
	const put = (organizationId: string, stored: Stored) =>
		delegations
			.put(
				{
					organizationId,
					id: stored.delegation.id,
					owner: stored.userId,
					scope: stored.delegation.parent.chat,
					status: stored.delegation.status,
				},
				stored,
			)
			.pipe(Effect.as(stored))
	const idFor = (input: CreateInput) =>
		input.parent.toolCallId === undefined
			? "dlg_" + randomUUID().replaceAll("-", "")
			: "dlg_" + hash([input.parent.chat, input.parent.toolCallId])
	return Delegations.of({
		create: (organizationId, input) =>
			records.transaction(
				"delegation:" + organizationId + ":" + input.parent.chat,
				Effect.gen(function* () {
					const id = idFor(input)
					const existing = yield* delegations.find(organizationId, id)
					if (Option.isSome(existing)) return existing.value
					const now = yield* Clock.currentTimeMillis
					return yield* put(organizationId, {
						userId: input.userId,
						author: input.author,
						chain: input.chain,
						...(input.request === undefined ? {} : { request: input.request }),
						delegation: {
							id,
							parent: input.parent,
							...(input.trigger === undefined
								? {}
								: { trigger: input.trigger }),
							bot: input.bot,
							chat: input.chat ?? null,
							status: input.status,
							task: input.task,
							...(input.reason === undefined ? {} : { reason: input.reason }),
							result: input.result ?? null,
							createdAt: now,
							updatedAt: now,
						},
					})
				}),
			),
		find: (organizationId, id) => delegations.find(organizationId, id),
		forChat: (organizationId, chat) =>
			delegations.list(organizationId, { scope: chat }),
		forChild: (organizationId, userId, chat) =>
			delegations
				.list(organizationId, { owner: userId })
				.pipe(
					Effect.map((list) =>
						list
							.filter((stored) => stored.delegation.chat === chat)
							.sort((a, b) => a.delegation.createdAt - b.delegation.createdAt),
					),
				),
		forRequest: (organizationId, chat, request) =>
			delegations
				.list(organizationId, { scope: chat })
				.pipe(
					Effect.map((list) =>
						Option.fromNullishOr(
							list.find((stored) => stored.request === request),
						),
					),
				),
		open: Effect.gen(function* () {
			const all = yield* Effect.forEach(
				DelegationsApi.OpenDelegationStatus.literals,
				(status) => delegations.withStatus(status),
			)
			return all.flat()
		}),
		change: (organizationId, id, expected, update) =>
			records.transaction(
				"delegation-item:" + organizationId + ":" + id,
				Effect.gen(function* () {
					const found = yield* delegations.find(organizationId, id)
					if (
						Option.isNone(found) ||
						!expected.includes(found.value.delegation.status)
					)
						return Option.none()
					const now = yield* Clock.currentTimeMillis
					const next = update(found.value)
					return Option.some(
						yield* put(organizationId, {
							...next,
							delegation: { ...next.delegation, updatedAt: now },
						}),
					)
				}),
			),
	})
})
export const layer = Layer.effect(Delegations, make)
