import { Chat, Turn } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import { Delegations as DelegationDomain } from "@openbot-build/domain"
import { Bots as BotsApi } from "@openbot-build/domain"
import {
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Order,
	pipe,
	Schema,
} from "effect"
import { Hex } from "effect/encoding"
import { hash } from "../capabilities/Capability.ts"
import { Chain } from "../chats/ChatHost.ts"
import { BotRecords } from "./BotRecords.ts"

type Delegation = DelegationDomain.Delegation

/**
 * A delegation as it is stored. `userId` is the member whose Chats hold the work.
 * `author` is who the work is for, so its result goes back to them. `chain` is the
 * work that gave it, and the work of the child goes on from there. `request` is the
 * request that decides whether the work may start.
 *
 * `delegation.usage.timeMs` is the running time before `runningSince`. `window` is the
 * usage when the limits last started, at the start or when a decider let the work go on.
 * A limit is reached when the usage since `window` reaches it.
 */
export const Stored = Schema.Struct({
	executionId: Schema.optionalKey(Execution.Id),
	/** Each new limit pause gets a new number and keeps its task Turn. */
	limitEpoch: Schema.optionalKey(Schema.Natural),
	limitTurnExecutionId: Schema.optionalKey(Execution.Id),
	delegation: DelegationDomain.Delegation,
	userId: Schema.String,
	author: Turn.Author,
	chain: Chain,
	request: Schema.optionalKey(Schema.String),
	window: Schema.optionalKey(DelegationDomain.DelegationUsage),
	runningSince: Schema.optionalKey(Schema.Finite),
})
export type Stored = typeof Stored.Type

export interface CreateInput {
	readonly id?: DelegationDomain.DelegationId
	readonly executionId?: Execution.Id
	readonly userId: string
	readonly author: Turn.Author
	readonly chain: Chain
	readonly parent: Delegation["parent"]
	readonly trigger?: Delegation["trigger"]
	readonly bot: BotsApi.BotId
	readonly task: string
	readonly reason?: string
	readonly limits?: DelegationDomain.DelegationLimits
	/** The task Chat of earlier work that this work goes on with. */
	readonly chat?: Chat.Id
	readonly status: "authorizing" | "queued" | "running" | "failed"
	readonly request?: string
	readonly result?: string
	/** Since when work that is made as running runs. */
	readonly runningSince?: number
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
		/**
		 * Changes a delegation when it still has one of the expected statuses, and `when`
		 * holds for it. Returns None when it does not, so two workers never do the same step.
		 */
		readonly change: (
			organizationId: string,
			id: string,
			expected: ReadonlyArray<Delegation["status"]>,
			update: (stored: Stored) => Stored,
			when?: (stored: Stored) => boolean,
		) => Effect.Effect<Option.Option<Stored>, BotsApi.BotStorageUnavailable>
	}
>()("@openbot-build/openbot/bots/Delegations") {}

/** Nothing used yet. */
export const noUsage: DelegationDomain.DelegationUsage = {
	timeMs: 0,
	steps: 0,
	costMicros: 0,
}

/** What the work used, with the running time up to now. */
export const usageOf = (
	stored: Stored,
	now: number,
): DelegationDomain.DelegationUsage => {
	const usage = stored.delegation.usage ?? noUsage
	return stored.runningSince === undefined
		? usage
		: {
				...usage,
				timeMs: usage.timeMs + Math.max(0, now - stored.runningSince),
			}
}

/** The delegation as people see it, with the running time up to now. */
export const view = (stored: Stored, now: number): Delegation =>
	stored.delegation.usage === undefined
		? stored.delegation
		: { ...stored.delegation, usage: usageOf(stored, now) }

const isOpenStatus = Schema.is(DelegationDomain.OpenDelegationStatus)

/** True when the work has not ended yet. */
export const isOpen = (stored: Stored) => isOpenStatus(stored.delegation.status)

const byCreation = Order.mapInput(
	Order.Number,
	(stored: Stored) => stored.delegation.createdAt,
)

export const make: Effect.Effect<
	typeof Delegations.Service,
	never,
	BotRecords | Crypto.Crypto
> = Effect.gen(function* () {
	const records = yield* BotRecords
	const crypto = yield* Crypto.Crypto
	const delegations = records.collection(
		"delegation",
		Stored,
		DelegationDomain.DelegationStatus,
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
		input.id !== undefined
			? Effect.succeed(input.id)
			: input.parent.toolCallId === undefined
				? crypto.randomUUIDv4({ format: "bytes" }).pipe(
						// A platform without secure random numbers is broken.
						Effect.orDie,
						Effect.map((uuid) => "dlg_" + Hex.encode(uuid)),
					)
				: Effect.map(
						hash(crypto, [input.parent.chat, input.parent.toolCallId]),
						(value) => "dlg_" + value,
					)
	return Delegations.of({
		create: (organizationId, input) =>
			records.transaction(
				"delegation:" + organizationId + ":" + input.parent.chat,
				Effect.gen(function* () {
					const id = yield* idFor(input)
					const existing = yield* delegations.find(organizationId, id)
					if (Option.isSome(existing)) return existing.value
					const now = yield* Clock.currentTimeMillis
					return yield* put(organizationId, {
						...(input.executionId === undefined
							? {}
							: { executionId: input.executionId }),
						userId: input.userId,
						author: input.author,
						chain: input.chain,
						...(input.request === undefined ? {} : { request: input.request }),
						...(input.runningSince === undefined
							? {}
							: { runningSince: input.runningSince }),
						delegation: {
							id: DelegationDomain.DelegationId.make(id),
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
							...(input.limits === undefined
								? {}
								: { limits: input.limits, usage: noUsage }),
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
			delegations.list(organizationId, { owner: userId }).pipe(
				Effect.map((list) =>
					pipe(
						list,
						Arr.filter((stored) => stored.delegation.chat === chat),
						Arr.sort(byCreation),
					),
				),
			),
		forRequest: (organizationId, chat, request) =>
			delegations
				.list(organizationId, { scope: chat })
				.pipe(
					Effect.map((list) =>
						Arr.findFirst(list, (stored) => stored.request === request),
					),
				),
		change: (organizationId, id, expected, update, when) =>
			records.transaction(
				"delegation-item:" + organizationId + ":" + id,
				Effect.gen(function* () {
					const found = yield* delegations.find(organizationId, id)
					if (
						Option.isNone(found) ||
						!Arr.contains(expected, found.value.delegation.status) ||
						(when !== undefined && !when(found.value))
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
