import { BotsApi } from "@openbot-build/api"
import { Effect, Layer } from "effect"
import { Billing } from "@openbot-build/server-billing/billing/Billing"
import * as MemoryLogs from "../src/plugin-bots/MemoryLogs.ts"
import * as TurnContext from "../src/plugin-chats/TurnContext.ts"
import * as Grants from "../src/plugin-capabilities/Grants.ts"
import * as Requests from "../src/plugin-capabilities/Requests.ts"
import * as Rules from "../src/plugin-capabilities/Rules.ts"
import * as BotMemories from "../src/plugin-bots/BotMemories.ts"
import * as MemoryBot from "../src/plugin-bots/MemoryBot.ts"
import * as Reminders from "../src/plugin-work/Reminders.ts"
import * as OpenWorkCount from "../src/plugin-bots/OpenWorkCount.ts"
import * as BotRecords from "../src/plugin-bots/BotRecords.ts"
import * as Bots from "../src/plugin-bots/Bots.ts"
import * as Delegations from "../src/plugin-bots/Delegations.ts"
import * as Judge from "../src/plugin-capabilities/Judge.ts"

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
