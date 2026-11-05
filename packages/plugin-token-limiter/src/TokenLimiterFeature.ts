/**
 * The limit on the input and output tokens of each Turn as a Bot feature. The
 * plugins file gives the limit as config. Each Turn keeps the limit in its
 * pin, so a new config counts only for new Turns.
 *
 * Make `version` higher only when an old pin can not be read with the new
 * `Settings`.
 */
import { Effect, Schema } from "effect"
import * as BotFeatures from "@openbot-build/conversation-contract/chats/BotFeatures"
import * as TokenLimiter from "./TokenLimiter.ts"

/** The id that Turn journals keep. Never change it. */
export const id = "@openbot-build/plugin-token-limiter"

/** A whole number from 1: the check of `TokenLimiter.make`. */
const MaxTokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** The config of the plugin in the plugins file. */
export const Config = Schema.Struct({ maxTokens: MaxTokens })
export type Config = typeof Config.Type

/** What the pin of a Turn keeps. */
export const Settings = Schema.Struct({ maxTokens: MaxTokens })

/** Makes the limit of one Turn phase from the settings of its pin only. */
const prepare = (settings: Schema.Json) =>
	Schema.decodeUnknownEffect(Settings)(settings).pipe(
		// A pin that does not decode means that `Settings` changed without a new version.
		Effect.orDie,
		Effect.map((pinned) =>
			BotFeatures.fromPlugin(id, TokenLimiter.make(pinned)),
		),
	)

/** The feature that the plugin gives while it runs with this config. */
export const contribution = (
	config: Config,
): BotFeatures.PluginContribution => ({
	id,
	version: 1,
	order: 102,
	build: "normal",
	review: true,
	restores: [],
	settings: Effect.succeed({ maxTokens: config.maxTokens }),
	prepare: (_fence, settings) => prepare(settings),
})
