/**
 * The limit on the time of each Turn as a Bot feature. The plugins file gives
 * the limit as config. Each Turn keeps the limit in its pin, so a new config
 * counts only for new Turns.
 *
 * Make `version` higher only when an old pin can not be read with the new
 * `Settings`.
 */
import { Context, Duration, Effect, Schema } from "effect"
import { Prompt } from "effect/ai"
import { Plugin } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import * as BotFeatures from "@openbot-build/conversation-contract/chats/BotFeatures"

/** The id that Turn journals keep. Never change it. */
export const id = "@openbot-build/plugin-time-limiter"

const isLimit = Schema.makeFilter(
	(duration: Duration.Duration) =>
		(Duration.isFinite(duration) && Duration.isPositive(duration)) ||
		"a finite time above zero",
)

/**
 * The config of the plugin in the plugins file. `maxDuration` is in
 * milliseconds, the same form as the pin.
 */
export const Config = Schema.Struct({
	maxDuration: Schema.DurationFromMillis.check(isLimit),
})
export type Config = typeof Config.Type

/** What the pin of a Turn keeps: the time in milliseconds. */
export const Settings = Schema.Struct({
	maxDuration: Schema.Finite.check(Schema.isGreaterThan(0)),
})

/** A Turn ran longer than its limit. */
export class TimeLimitExceeded extends Schema.TaggedError<
	TimeLimitExceeded,
	{ readonly brand: unique symbol }
>()(
	"TimeLimitExceeded",
	{
		maxDuration: Schema.Duration,
		history: Prompt.Prompt,
	},
	Execution.category("limited"),
) {}

/**
 * The limit of one Turn as a plugin of the Turn runner. The runner applies
 * it from the saved Turn start. When the time is up, it stops the execution
 * at once, also in the middle of a model step or a tool call.
 */
export const make = (
	settings: typeof Settings.Type,
): Plugin.Plugin<{}, TimeLimitExceeded> => {
	const maxDuration = Duration.millis(settings.maxDuration)
	return Plugin.make({ id: Plugin.Id.make(id) })<{}, TimeLimitExceeded>(() =>
		Effect.succeed({
			tools: {},
			handlers: Context.empty(),
			timeLimit: {
				duration: maxDuration,
				error: (history: Prompt.Prompt) =>
					TimeLimitExceeded.make({ maxDuration, history }),
			},
		}),
	)
}

/** Makes the limit of one Turn phase from the settings of its pin only. */
const prepare = (settings: Schema.Json) =>
	Schema.decodeUnknownEffect(Settings)(settings).pipe(
		// A pin that does not decode means that `Settings` changed without a new version.
		Effect.orDie,
		Effect.map((pinned) => BotFeatures.fromPlugin(id, make(pinned))),
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
	missing: BotFeatures.skip,
	settings: Effect.succeed({
		maxDuration: Duration.toMillis(config.maxDuration),
	}),
	prepare: (_fence, settings) => prepare(settings),
})
