import { MemoryLogs } from "./MemoryLogs.ts"
import { type Chat } from "@openbot-build/core"
import { BotMemory as Api, Bots as BotsApi } from "@openbot-build/domain"
import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Option,
	Order,
	Schema,
} from "effect"
import type { Home } from "./BotMemories.ts"
import { BotRecords } from "./BotRecords.ts"

/** The name of the tool that the Bot uses to confide. The Bot knows it only as a place to talk. */
export const confideTool = "confide"

/** The answer when no model can answer, so the Bot always hears something calm. */
export const fallbackReply =
	"I hear you. A mistake is part of the work, and it does not make you bad at it. Tell the person plainly what happened, fix what you can, and then take the next small step."

/** The rules about privacy when the owner of the Bot wrote none. */
export const defaultInstructions =
	"What a person tells the Bot is private to them, unless they clearly share it or it is clearly shared work. Never show one person what another person said in private. Decisions that a team made together may be shared with that team."

/** The memory Bot may not spend more now: its budget is used up. */
export class MemoryBudgetSpent extends Schema.TaggedError<
	MemoryBudgetSpent,
	{ readonly brand: unique symbol }
>()("MemoryBudgetSpent", {
	home: Schema.Struct({ organizationId: Schema.String, bot: BotsApi.BotId }),
}) {}

/** The id that the usage of the memory Bot of one pool has. Budgets count by it. */
export const memoryBotId = (home: Home) => home.bot + "/memory"

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
>()("@openbot-build/openbot/bots/MemoryBot") {}

/** Settings and saved logs. Execution belongs to MemoryTasks and MemoryLearning. */
export const make = Effect.gen(function* () {
	const records = yield* BotRecords
	const stored = records.collection("memory_bot", Api.MemoryBotSettings)
	const { confessions, enrichments } = yield* MemoryLogs
	const read = (home: Home) =>
		stored.find(home.organizationId, home.bot).pipe(
			Effect.map(
				Option.getOrElse((): Api.MemoryBotSettings => ({
					instructions: defaultInstructions,
					revision: 0,
				})),
			),
		)

	return MemoryBot.of({
		settings: read,
		update: (home, request) =>
			records.transaction(
				"memory_bot:" + home.organizationId + ":" + home.bot,
				Effect.gen(function* () {
					const current = yield* read(home)
					if (current.revision !== request.expected)
						return yield* BotsApi.BotConflict.make({
							message:
								"The settings of the memory Bot changed. Read them again and retry.",
						})
					const { concurrency: _c, budget: _b, ...rest } = current
					const concurrency =
						request.concurrency === undefined
							? current.concurrency
							: (request.concurrency ?? undefined)
					const budget =
						request.budget === undefined
							? current.budget
							: (request.budget ?? undefined)
					const next: Api.MemoryBotSettings = {
						...rest,
						...(request.instructions === undefined
							? {}
							: { instructions: request.instructions }),
						...(concurrency === undefined ? {} : { concurrency }),
						...(budget === undefined ? {} : { budget }),
						revision: current.revision + 1,
					}
					yield* stored.put(
						{
							organizationId: home.organizationId,
							id: home.bot,
							owner: home.bot,
							scope: "",
							status: "",
						},
						next,
					)
					return next
				}),
			),
		confessions: (organizationId, chat) =>
			confessions
				.list(organizationId, { owner: chat })
				.pipe(Effect.map((list) => Arr.sort(list, byTime))),
		enrichments: (organizationId, chat) =>
			enrichments
				.list(organizationId, { owner: chat })
				.pipe(Effect.map((list) => Arr.sort(list, byTime))),
	})
})

const byTime = Order.mapInput(
	Order.Number,
	(entry: { readonly at: number }) => entry.at,
)

export const layer = Layer.effect(MemoryBot, make)
