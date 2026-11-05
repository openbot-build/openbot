/**
 * The limit on the model steps of each Turn as a Bot feature. The plugins
 * file gives the limit as config. Each Turn keeps the limit in its pin, so a
 * new config counts only for new Turns.
 *
 * Make `version` higher only when an old pin can not be read with the new
 * `Settings`.
 */
import { Effect, Schema } from "effect"
import * as BotFeatures from "@openbot-build/conversation-contract/chats/BotFeatures"
import * as TurnLimiter from "./TurnLimiter.ts"

/** The id that Turn journals keep. Never change it. */
export const id = "@openbot-build/plugin-turn-limiter"

/** A whole number from 1: the check of `TurnLimiter.make`. */
const MaxSteps = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** The config of the plugin in the plugins file. */
export const Config = Schema.Struct({ maxSteps: MaxSteps })
export type Config = typeof Config.Type

/** What the pin of a Turn keeps. */
export const Settings = Schema.Struct({ maxSteps: MaxSteps })

/** Makes the limit of one Turn phase from the settings of its pin only. */
const prepare = (settings: Schema.Json) =>
	Schema.decodeUnknownEffect(Settings)(settings).pipe(
		// A pin that does not decode means that `Settings` changed without a new version.
		Effect.orDie,
		Effect.map((pinned) =>
			BotFeatures.fromPlugin(id, TurnLimiter.make(pinned)),
		),
	)

/** The feature that the plugin gives while it runs with this config. */
export const contribution = (
	config: Config,
): BotFeatures.PluginContribution => ({
	id,
	version: 1,
	order: 100,
	build: "normal",
	review: true,
	restores: [],
	settings: Effect.succeed({ maxSteps: config.maxSteps }),
	prepare: (_fence, settings) => prepare(settings),
})
