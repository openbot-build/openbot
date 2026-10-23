import type { Session, Turn } from "@openbot-build/core"
import type { BotsApi, Caller } from "@openbot-build/api"
import { Context } from "effect"
import type { Chain } from "../sessions/SessionHost.ts"

/**
 * The Bot that runs the current Turn, and who it works for.
 * The Bot plugin gives it to each Turn. Capability checks read it.
 */
export class Work extends Context.Service<
	Work,
	{
		/** The member, with the token that started the work when there was one. */
		readonly caller: Caller
		readonly namespace: string
		readonly bot: BotsApi.Bot
		/** The delegation chain: who gave the work to whom. */
		readonly chain: Chain
		/** The owner chain of the Bot, from the top, ending with the Bot. They decide its requests. */
		readonly deciders: ReadonlyArray<BotsApi.BotId>
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
