import type { Session, Turn } from "@openbot-build/core"
import type { AgentsApi, Caller } from "@openbot-build/api"
import { Context } from "effect"
import type { Chain } from "../sessions/SessionHost.ts"

/**
 * The Agent that runs the current Turn, and who it works for.
 * The Agent plugin gives it to each Turn. Capability checks read it.
 */
export class Work extends Context.Service<
	Work,
	{
		/** The member, with the token that started the work when there was one. */
		readonly caller: Caller
		readonly namespace: string
		readonly agent: AgentsApi.Agent
		readonly chain: Chain
		readonly session: Session.Id
		readonly turn: Turn.Id
	}
>()("@openbot-build/openbot/capabilities/Work") {}

/** The caller that a chain acts for. */
export const callerOf = (chain: Chain): Caller => ({
	kind: chain.tokenId === undefined ? "member" : "user_token",
	organizationId: chain.organizationId,
	userId: chain.userId,
	...(chain.tokenId === undefined ? {} : { tokenId: chain.tokenId }),
})
