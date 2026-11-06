/**
 * The limit on the model steps of each Turn as a Bot feature. The plugins
 * file gives the limit as config. Each Turn keeps the limit in its pin, so a
 * new config counts only for new Turns.
 *
 * Make `version` higher only when an old pin can not be read with the new
 * `Settings`.
 */
import { Context, Effect, Schema } from "effect"
import { Prompt } from "effect/ai"
import { Plugin } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import * as BotFeatures from "@openbot-build/conversation-contract/chats/BotFeatures"

/** The id that Turn journals keep. Never change it. */
export const id = "@openbot-build/plugin-turn-limiter"

/** A whole number from 1. */
const MaxSteps = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** The config of the plugin in the plugins file. */
export const Config = Schema.Struct({ maxSteps: MaxSteps })
export type Config = typeof Config.Type

/** What the pin of a Turn keeps. */
export const Settings = Schema.Struct({ maxSteps: MaxSteps })

/** A Turn made more model requests than its limit. */
export class ModelStepLimitExceeded extends Schema.TaggedError<
	ModelStepLimitExceeded,
	{ readonly brand: unique symbol }
>()(
	"ModelStepLimitExceeded",
	{
		maxSteps: Schema.Int,
		history: Prompt.Prompt,
	},
	Execution.category("limited"),
) {}

/**
 * The limit of one Turn as a plugin of the Turn runner. It checks the saved
 * step count before each model step. `maxSteps` counts every model request,
 * also the first one.
 */
export const make = ({
	maxSteps,
}: typeof Settings.Type): Plugin.Plugin<{}, ModelStepLimitExceeded> =>
	Plugin.make({ id: Plugin.Id.make(id) })<{}, ModelStepLimitExceeded>(() =>
		Effect.succeed({
			tools: {},
			handlers: Context.empty(),
			beforeStep: ({ step, history, kind }) =>
				kind === "model" && step > maxSteps
					? Effect.fail(ModelStepLimitExceeded.make({ maxSteps, history }))
					: Effect.succeed(true),
		}),
	)

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
	order: 100,
	build: "normal",
	review: true,
	restores: [],
	missing: BotFeatures.skip,
	settings: Effect.succeed({ maxSteps: config.maxSteps }),
	prepare: (_fence, settings) => prepare(settings),
})
