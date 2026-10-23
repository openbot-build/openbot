import { BotsApi } from "@openbot-build/api"
import { Effect, Layer } from "effect"
import * as BotLayers from "../src/bots/BotLayers.ts"
import * as Judge from "../src/capabilities/Judge.ts"

/** A lasting Bot for tests that use Sessions without the Bot services. */
export const bot: BotsApi.Bot = {
	id: BotsApi.BotId.make("bot_test"),
	kind: "persistent",
	owner: { _tag: "Member", userId: "test-user" },
	name: "Assistant",
	role: "Helps one person",
	instructions: "",
	archived: false,
	revision: 0,
	createdAt: 0,
	updatedAt: 0,
}

/** What a direct Session needs, for the test bot and member. */
export const direct = (
	member: { readonly organizationId?: string; readonly userId?: string } = {},
) => ({
	bot,
	kind: "direct" as const,
	chain: {
		organizationId: member.organizationId ?? "test-organization",
		userId: member.userId ?? "test-user",
		bots: [bot.id],
		sessions: [],
	},
})

const noHelper = () =>
	Effect.fail(
		new Judge.HelperModelUnavailable({
			message: "No helper model in this test.",
		}),
	)

/** Helper models that are not there. The judge then answers no_match, and memory learns nothing. */
export const layerNoHelper = Layer.succeed(Judge.HelperModel, {
	rules: noHelper,
	botMemory: noHelper,
})

/** The Bot services for tests that serve the HTTP API without a coordinator. */
export const layerBotServices = BotLayers.layer({ helper: layerNoHelper })
