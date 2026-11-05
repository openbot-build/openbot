import type { Chat, Turn } from "@openbot-build/core"
import {
	Bots as BotDomain,
	Execution,
	type ExecutionIdentity,
} from "@openbot-build/domain"
import { Context, Effect, Schema } from "effect"
import { Work } from "../capabilities/Work.ts"
import { type OrganizationUnavailable } from "@openbot-build/identity-contract/organization/Organization"
import * as ChatHost from "./ChatHost.ts"

/** The owner or actor of a Turn is no longer an active member. */
export class MemberInactive extends Schema.TaggedError<
	MemberInactive,
	{ readonly brand: unique symbol }
>()("TurnContext.MemberInactive", { userId: Schema.String }) {}

export type Failure =
	| BotDomain.BotNotFound
	| BotDomain.BotStorageUnavailable
	| OrganizationUnavailable
	| MemberInactive
	| Execution.Forbidden

/** Builds Work from an accepted Turn or tool frame. Its caller checks the execution fence. */
export class TurnContext extends Context.Service<
	TurnContext,
	{
		readonly prepare: (input: {
			readonly identity: ExecutionIdentity
			readonly namespace: string
			readonly chat: Chat.Id
			readonly host: ChatHost.ChatHostState
			readonly turn: Turn.Id
		}) => Effect.Effect<typeof Work.Service, Failure>
	}
	// @effect-diagnostics-next-line deterministicKeys:off -- The key keeps the name it had in the openbot package, so code built for that name still finds this service.
>()("@openbot-build/openbot/conversation-contract/chats/TurnContext") {}
