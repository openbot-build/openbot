import type { Services as AuthorizationServices } from "../authorization/Authorize.ts"
import { BotsApi, type Caller } from "@openbot-build/api"
import { Effect } from "effect"
import { Settings } from "../settings/Settings.ts"
import { Bots, type Failure } from "./Bots.ts"

/** The services that the default Bot needs. */
export type Services = Bots | Settings

/**
 * Checks that the caller can make a Bot their default Bot.
 * It must be a lasting top Bot: one of the caller's own, or a shared one.
 * The caller must be able to give it work.
 */
export const check = (
	caller: Caller,
	id: string,
): Effect.Effect<BotsApi.Bot, Failure, Bots | AuthorizationServices> =>
	Effect.gen(function* () {
		const bots = yield* Bots
		const bot = yield* bots.access(caller, id, "bots.delegate")
		const top =
			bot.owner._tag === "Organization" ||
			(bot.owner._tag === "Member" && bot.owner.userId === caller.userId)
		if (!top)
			return yield* BotsApi.BotInvalid.make({
				message:
					"A default Bot must be one of your own top Bots or a shared Bot.",
			})
		if (bot.archived)
			return yield* BotsApi.BotInvalid.make({
				message: "An archived Bot cannot be your default Bot.",
			})
		return bot
	})

/** The default Bot of the caller, from their member settings. */
export const resolve = (
	caller: Caller,
): Effect.Effect<BotsApi.Bot, Failure, Services | AuthorizationServices> =>
	Effect.gen(function* () {
		const settings = yield* Settings
		const { document } = yield* settings
			.member(caller.organizationId, caller.userId)
			.pipe(Effect.mapError(() => BotsApi.BotStorageUnavailable.make({})))
		const id = document.defaultBot ?? null
		if (id === null)
			return yield* BotsApi.BotInvalid.make({
				message:
					"You have no default Bot. Name a Bot, or set a default Bot in your settings.",
			})
		return yield* check(caller, id)
	})
