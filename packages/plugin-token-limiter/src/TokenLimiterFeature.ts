/**
 * The limit on the input and output tokens of each Turn as a Bot feature. The
 * plugins file gives the limit as config. Each Turn keeps the limit in its
 * pin, so a new config counts only for new Turns.
 *
 * Make `version` higher only when an old pin can not be read with the new
 * `Settings`.
 */
import { Array as Arr, Context, Effect, Schema } from "effect"
import { Prompt } from "effect/ai"
import { Plugin } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import * as BotFeatures from "@openbot-build/conversation-contract/chats/BotFeatures"

/** The id that Turn journals keep. Never change it. */
export const id = "@openbot-build/plugin-token-limiter"

/** A whole number from 1. */
const MaxTokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** The config of the plugin in the plugins file. */
export const Config = Schema.Struct({ maxTokens: MaxTokens })
export type Config = typeof Config.Type

/** What the pin of a Turn keeps. */
export const Settings = Schema.Struct({ maxTokens: MaxTokens })

/** A Turn used more input and output tokens than its limit. */
export class TokenLimitExceeded extends Schema.TaggedError<
	TokenLimitExceeded,
	{ readonly brand: unique symbol }
>()(
	"TokenLimitExceeded",
	{
		maxTokens: Schema.Int,
		usedTokens: Schema.Int,
		history: Prompt.Prompt,
	},
	Execution.category("limited"),
) {}

/**
 * The limit of one Turn as a plugin of the Turn runner. It checks the saved
 * usage before each model step, also after recovery. A model step that has
 * started can finish. The next step fails when the used tokens reach the
 * limit.
 */
export const make = ({
	maxTokens,
}: typeof Settings.Type): Plugin.Plugin<{}, TokenLimitExceeded> =>
	Plugin.make({ id: Plugin.Id.make(id) })<{}, TokenLimitExceeded>(() =>
		Effect.succeed({
			tools: {},
			handlers: Context.empty(),
			beforeStep: ({ turn, history, kind }) => {
				const usedTokens = Arr.reduce(
					turn.usage ?? [],
					0,
					(total, usage) =>
						total +
						(usage.inputTokens.total ?? 0) +
						(usage.outputTokens.total ?? 0),
				)
				return kind === "model" && usedTokens >= maxTokens
					? Effect.fail(
							TokenLimitExceeded.make({ maxTokens, usedTokens, history }),
						)
					: Effect.succeed(true)
			},
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
	order: 102,
	build: "normal",
	review: true,
	restores: [],
	missing: BotFeatures.skip,
	settings: Effect.succeed({ maxTokens: config.maxTokens }),
	prepare: (_fence, settings) => prepare(settings),
})
