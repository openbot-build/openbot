import { Bots as BotsApi } from "@openbot-build/domain"

/** One memory pool: the Bot and its organization. */
export interface Home {
	readonly organizationId: string
	readonly bot: BotsApi.BotId
}
