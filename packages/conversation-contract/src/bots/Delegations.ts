import { Chat, Turn } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import { Delegations as DelegationDomain } from "@openbot-build/domain"
import { Bots as BotsApi } from "@openbot-build/domain"
import { Context, Effect, Option, Schema } from "effect"
import { Chain } from "../chats/ChatHost.ts"

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
	// @effect-diagnostics-next-line deterministicKeys:off -- The key keeps the name it had in the openbot package, so code built for that name still finds this service.
>()("@openbot-build/openbot/conversation-contract/bots/Delegations") {}

/** Nothing used yet. */
export const noUsage: DelegationDomain.DelegationUsage = {
	timeMs: 0,
	steps: 0,
	costMicros: 0,
}

export { type Delegation }
