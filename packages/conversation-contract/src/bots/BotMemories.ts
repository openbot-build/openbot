import type { BotId } from "@openbot-build/domain/BotId"

/** One memory pool: the Bot and its organization. */
export interface Home {
	readonly organizationId: string
	readonly bot: BotId
}
