/** The turn-limiter plugin: a limit on the model steps of each Turn. It is off at first. */
import { Plugin as GraftPlugin } from "@graftland/graft"
import { Effect } from "effect"
import { BotFeatures } from "@openbot-build/conversation-contract/chats/BotFeatures"
import * as Feature from "@openbot-build/server-plugin/Feature"
import * as TurnLimiterFeature from "./TurnLimiterFeature.ts"

// A new config restarts the plugin: `apply` gives no update.
export default GraftPlugin.make({
	name: TurnLimiterFeature.id,
	inject: [BotFeatures],
	retry: Feature.retry,
	config: TurnLimiterFeature.Config,
	apply: (config) =>
		Effect.gen(function* () {
			const features = yield* BotFeatures
			yield* features.contribute(TurnLimiterFeature.contribution(config))
		}),
})
