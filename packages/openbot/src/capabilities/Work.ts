import type { Chat, Turn } from "@openbot-build/core"
import type { Bots as BotsApi } from "@openbot-build/domain"
import type { ExecutionIdentity } from "@openbot-build/domain"
import { Context } from "effect"
import type { Chain } from "../chats/ChatHost.ts"

/**
 * The Bot that runs the current Turn, and who it works for.
 * The Turn host builds it before the tools. Capability checks read it.
 */
export class Work extends Context.Service<
	Work,
	{
		/** The owner, actor and original token of this work. */
		readonly identity: ExecutionIdentity
		readonly namespace: string
		readonly bot: BotsApi.Bot
		/** The delegation chain: who gave the work to whom. */
		readonly chain: Chain
		/** The owner chain of the Bot, from the top, ending with the Bot. They decide its requests. */
		readonly deciders: ReadonlyArray<BotsApi.BotId>
		readonly chat: Chat.Id
		readonly turn: Turn.Id
	}
>()("@openbot-build/openbot/capabilities/Work") {}
