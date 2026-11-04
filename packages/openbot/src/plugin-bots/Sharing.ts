import type { Bots as BotsApi } from "@openbot-build/domain"

/**
 * Only a lasting top Bot of its own organization can be shared: one that a member or
 * the organization owns, that is not archived, and that is not itself a linked Bot.
 * Above it there is only the person, so in another organization it works like their own Bot.
 */
export const shareable = (bot: BotsApi.Bot) =>
	!bot.archived &&
	bot.source === undefined &&
	(bot.owner._tag === "Member" || bot.owner._tag === "Organization")
