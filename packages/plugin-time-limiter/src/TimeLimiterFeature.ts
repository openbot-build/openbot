/**
 * The limit on the time of each Turn as a Bot feature. The plugins file gives
 * the limit as config. Each Turn keeps the limit in its pin, so a new config
 * counts only for new Turns.
 *
 * Make `version` higher only when an old pin can not be read with the new
 * `Settings`.
 */
import { Duration, Effect, Schema } from "effect"
import * as BotFeatures from "@openbot-build/conversation-contract/chats/BotFeatures"
import * as TimeLimiter from "./TimeLimiter.ts"

/** The id that Turn journals keep. Never change it. */
export const id = "@openbot-build/plugin-time-limiter"

const isLimit = Schema.makeFilter(
	(duration: Duration.Duration) =>
		(Duration.isFinite(duration) && Duration.isPositive(duration)) ||
		"a finite time above zero",
)

/**
 * The config of the plugin in the plugins file. `maxDuration` is in
 * milliseconds, or a text such as `"5 minutes"`.
 */
export const Config = Schema.Struct({
	maxDuration: Schema.Union([
		Schema.DurationFromMillis,
		Schema.DurationFromString,
	]).check(isLimit),
})
export type Config = typeof Config.Type

/** What the pin of a Turn keeps: the time in milliseconds. */
export const Settings = Schema.Struct({
	maxDuration: Schema.Finite.check(Schema.isGreaterThan(0)),
})

/** Makes the limit of one Turn phase from the settings of its pin only. */
const prepare = (settings: Schema.Json) =>
	Schema.decodeUnknownEffect(Settings)(settings).pipe(
		// A pin that does not decode means that `Settings` changed without a new version.
		Effect.orDie,
		Effect.map((pinned) =>
			BotFeatures.fromPlugin(id, TimeLimiter.make(pinned)),
		),
	)

/** The feature that the plugin gives while it runs with this config. */
export const contribution = (
	config: Config,
): BotFeatures.PluginContribution => ({
	id,
	version: 1,
	order: 101,
	build: "normal",
	review: true,
	restores: [],
	settings: Effect.succeed({
		maxDuration: Duration.toMillis(config.maxDuration),
	}),
	prepare: (_fence, settings) => prepare(settings),
})
