/** The token-limiter plugin: a limit on the tokens of each Turn. It is off at first. */
import { Plugin as GraftPlugin } from "@graftland/graft"
import { Effect } from "effect"
import { BotFeatures } from "@openbot-build/conversation-contract/chats/BotFeatures"
import * as Feature from "@openbot-build/server-plugin/Feature"
import * as TokenLimiterFeature from "./TokenLimiterFeature.ts"

// A new config restarts the plugin: `apply` gives no update.
export default GraftPlugin.make({
	name: TokenLimiterFeature.id,
	inject: [BotFeatures],
	retry: Feature.retry,
	config: TokenLimiterFeature.Config,
	apply: (config) =>
		Effect.gen(function* () {
			const features = yield* BotFeatures
			yield* features.contribute(TokenLimiterFeature.contribution(config))
		}),
})
