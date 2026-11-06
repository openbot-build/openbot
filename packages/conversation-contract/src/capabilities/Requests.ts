import type { BotId } from "@openbot-build/domain/BotId"
import { type AppCalls } from "@openbot-build/domain"
import type { Chat, Turn } from "@openbot-build/core"
import { Requests as RequestDomain } from "@openbot-build/domain"
import { CodeRuns as CodeDomain } from "@openbot-build/domain"
import { Bots as BotsApi } from "@openbot-build/domain"
import { Context, Effect, Option, Schema } from "effect"
import { Chain } from "../chats/ChatHost.ts"

type Request = RequestDomain.CapabilityRequest

/**
 * A request as it is stored: the public record and the delegation chain it came through.
 * The deciders are the owner chain in `request.chain`.
 * `call` is the tool call that waits for the request. When the request is allowed,
 * OpenBot gives it back to the Chat, and the call runs then.
 */
export const Stored = Schema.Struct({
	request: RequestDomain.CapabilityRequest,
	chain: Chain,
	/** The Grant kept for the exact call that this request allows. */
	approvalGrant: Schema.optionalKey(BotsApi.GrantId),
	call: Schema.optionalKey(
		Schema.Struct({
			name: Schema.String,
			params: Schema.Json,
			/** The source of a host action, such as an action of an App view. */
			source: Schema.optionalKey(Schema.JsonObject),
		}),
	),
})

export type Stored = typeof Stored.Type

export interface Decision {
	readonly by: BotsApi.Decider
	readonly allow: boolean
	readonly scope?: BotsApi.GrantScope
	readonly reason?: string
	readonly question?: string
	readonly expected?: number
	/** For an allow by a Bot: true when the Bot holds the capability itself. */
	readonly holds?: boolean
	/** Keep the decision as a Rule for the requesting Bot. */
	readonly rule?: string
}

/**
 * How one request waits. `person` sends it to the person at once, not to the Bot above.
 * `timeoutMs` replaces the timeout of the organization. `onExpire` says what happens when
 * nobody answers in time. Without it, the request is denied.
 */
export interface Ask {
	readonly person?: boolean
	readonly timeoutMs?: number
	readonly onExpire?: "allow" | "deny"
}

/** The result of a decision: the request is final, or it went up to the next decider. */
export type Outcome =
	| { readonly _tag: "Final"; readonly stored: Stored }
	| { readonly _tag: "Escalated"; readonly stored: Stored }

/**
 * Requests of Bots for capabilities. A request waits for one decider at a time.
 * This service only keeps records. The coordinator starts reviews and lets the work go on.
 */
export class Requests extends Context.Service<
	Requests,
	{
		readonly create: (
			organizationId: string,
			input: {
				readonly bot: BotId
				readonly chain: Chain
				/** The owner chain of the Bot, from the top, ending with the Bot. */
				readonly deciders: ReadonlyArray<BotId>
				readonly capability: BotsApi.Capability
				readonly reason: string
				readonly chat: Chat.Id
				readonly turn: Turn.Id
				readonly toolCallId: string
				readonly app?: AppCalls.Invocation
				readonly code?: CodeDomain.RequestCode
				readonly ask?: Ask
				readonly call?: NonNullable<Stored["call"]>
				/** A request that is decided at once, for example by a Grant or by policy. */
				readonly decided?: {
					readonly allow: boolean
					readonly by: BotsApi.Decider
					readonly reason?: string
				}
			},
		) => Effect.Effect<Stored, BotsApi.BotStorageUnavailable>
		readonly find: (
			organizationId: string,
			id: string,
		) => Effect.Effect<Option.Option<Stored>, BotsApi.BotStorageUnavailable>
		/** The requests that wait for a person, or that the person decided. */
		readonly forPerson: (
			organizationId: string,
			userId: string,
			status?: Request["status"],
		) => Effect.Effect<ReadonlyArray<Request>, BotsApi.BotStorageUnavailable>
		/** The requests of one Chat. */
		readonly forChat: (
			organizationId: string,
			chat: Chat.Id,
		) => Effect.Effect<ReadonlyArray<Stored>, BotsApi.BotStorageUnavailable>
		readonly decide: (
			organizationId: string,
			id: string,
			decision: Decision,
		) => Effect.Effect<
			Outcome,
			| RequestDomain.RequestNotFound
			| RequestDomain.RequestConflict
			| BotsApi.BotStorageUnavailable
		>
		/**
		 * Sends a pending request to the next decider without support, for example when a
		 * review ended without a decision.
		 */
		readonly pass: (
			organizationId: string,
			id: string,
			from: BotId,
		) => Effect.Effect<Option.Option<Stored>, BotsApi.BotStorageUnavailable>
		/** Closes one pending request when its time is over. */
		readonly expireOne: (
			organizationId: string,
			id: string,
		) => Effect.Effect<Option.Option<Stored>, BotsApi.BotStorageUnavailable>
		/** Closes one request after its execution releases its resources. */
		readonly cancelOne: (
			organizationId: string,
			id: string,
			reason?: string,
		) => Effect.Effect<Option.Option<Stored>, BotsApi.BotStorageUnavailable>
	}
>()("@openbot-build/conversation-contract/capabilities/Requests") {}

export { type Request }
