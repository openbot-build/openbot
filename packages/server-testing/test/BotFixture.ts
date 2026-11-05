import { BotsApi } from "@openbot-build/api"
import { Effect, Layer } from "effect"
import { Billing } from "@openbot-build/server-billing/billing/Billing"
import * as MemoryLogs from "@openbot-build/plugin-bots/MemoryLogs"
import * as TurnContext from "@openbot-build/plugin-chats/TurnContext"
import * as Grants from "@openbot-build/plugin-capabilities/Grants"
import * as Requests from "@openbot-build/plugin-capabilities/Requests"
import * as Rules from "@openbot-build/plugin-capabilities/Rules"
import * as BotMemories from "@openbot-build/plugin-bots/BotMemories"
import * as MemoryBot from "@openbot-build/plugin-bots/MemoryBot"
import * as Reminders from "@openbot-build/plugin-work/Reminders"
import * as OpenWorkCount from "@openbot-build/plugin-bots/OpenWorkCount"
import * as BotRecords from "@openbot-build/plugin-bots/BotRecords"
import * as Bots from "@openbot-build/plugin-bots/Bots"
import * as Delegations from "@openbot-build/plugin-bots/Delegations"
import * as Judge from "@openbot-build/plugin-capabilities/Judge"

/** A Bot for tests that use Chats without the Bot services. */
export const bot: BotsApi.Bot = {
	id: BotsApi.BotId.make("bot_test"),
	owner: { _tag: "Member", userId: "test-user" },
	name: "Assistant",
	role: "Helps one person",
	instructions: "",
	archived: false,
	revision: 0,
	createdAt: 0,
	updatedAt: 0,
}

/** What a direct Chat needs, for the test bot and member. */
export const direct = (
	member: { readonly organizationId?: string; readonly userId?: string } = {},
) => ({
	bot,
	kind: "direct" as const,
	chain: {
		organizationId: member.organizationId ?? "test-organization",
		userId: member.userId ?? "test-user",
		bots: [bot.id],
		chats: [],
	},
})

const noHelper = () =>
	Effect.fail(
		Judge.HelperModelUnavailable.make({
			message: "No helper model in this test.",
		}),
	)

/** Helper models that are not there. The judge then answers no_match, and memory learns nothing. */
export const layerNoHelper = Layer.succeed(Judge.HelperModel, {
	rules: noHelper,
	botMemory: noHelper,
})

/**
 * Billing where nothing costs money, for tests that do not count costs. A
 * budget of work or of the memory Bot then never ends. It has only the
 * methods that the Bot services call. Any other method fails with a defect.
 */
export const layerNoCosts = Layer.mock(Billing, {
	botSpend: () => Effect.succeed(0),
	chatSpend: () => Effect.succeed(0),
})

/**
 * The Bot services: records, Bots, memory, delegations, Grants, Rules and
 * requests. Turn workflows build tools, policy checks and approvals in their
 * scopes.
 */
const layerBots = TurnContext.layer.pipe(
	Layer.provideMerge(OpenWorkCount.layer),
	Layer.provideMerge(Reminders.layer),
	Layer.provideMerge(Requests.layer),
	Layer.provideMerge(MemoryBot.layer),
	Layer.provideMerge(
		Layer.mergeAll(
			Grants.layer,
			Rules.layer,
			Delegations.layer,
			BotMemories.layer,
			Bots.layer,
		),
	),
	Layer.provideMerge(Layer.merge(BotRecords.layer, MemoryLogs.layer)),
)

/** The Bot services for tests that serve the HTTP API without a coordinator. */
export const layerBotServices = layerBots.pipe(
	Layer.provideMerge(layerNoHelper),
	Layer.provide(layerNoCosts),
)
