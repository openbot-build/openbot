import { type Chat } from "@openbot-build/core"
import { BotMemory as Api, Bots as BotsApi } from "@openbot-build/domain"
import { Context, Effect } from "effect"
import type { Home } from "./BotMemories.ts"

export class MemoryBot extends Context.Service<
	MemoryBot,
	{
		readonly settings: (
			home: Home,
		) => Effect.Effect<Api.MemoryBotSettings, BotsApi.BotStorageUnavailable>
		readonly update: (
			home: Home,
			request: Api.UpdateMemoryBotRequest,
		) => Effect.Effect<
			Api.MemoryBotSettings,
			BotsApi.BotConflict | BotsApi.BotStorageUnavailable
		>
		readonly confessions: (
			organizationId: string,
			chat: Chat.Id,
		) => Effect.Effect<
			ReadonlyArray<Api.Confession>,
			BotsApi.BotStorageUnavailable
		>
		readonly enrichments: (
			organizationId: string,
			chat: Chat.Id,
		) => Effect.Effect<
			ReadonlyArray<Api.Enrichment>,
			BotsApi.BotStorageUnavailable
		>
	}
>()("@openbot-build/conversation-contract/bots/MemoryBot") {}
