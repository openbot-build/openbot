import { BotsApi } from "@openbot-build/api"
import { Effect, Layer } from "effect"
import { Billing } from "../src/billing/Billing.ts"
import * as BotLayers from "../src/bots/BotLayers.ts"
import * as Judge from "../src/capabilities/Judge.ts"

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

/** The Bot services for tests that serve the HTTP API without a coordinator. */
export const layerBotServices = BotLayers.layer.pipe(
	Layer.provideMerge(layerNoHelper),
	Layer.provide(layerNoCosts),
)
