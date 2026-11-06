/**
 * Models that the program itself gives, such as the simulated models of the
 * development server or of a test. They come from outside of OpenBot: the
 * host gives them as an outside service. The API cannot change them, and every
 * organization can use them. By default there are none.
 */
import { Config } from "@openbot-build/core"
import { Context, type Effect } from "effect"
import type { LanguageModel } from "effect/ai"

/** The models that the program gives. */
export interface Builtin {
	/** The default of a test or development platform. */
	readonly defaultModel?: Config.Selection
	readonly providers: ReadonlyArray<Config.Provider>
	readonly models: ReadonlyArray<Config.Model>
	readonly resolve: (
		selection: Config.Selection,
	) => Effect.Effect<
		LanguageModel.LanguageModel,
		Config.ModelConfigurationError
	>
}

/** The models that the program gives. With no value, there are none. */
export const BuiltinModels = Context.Reference<Builtin | undefined>(
	"@openbot-build/models-contract/BuiltinModels",
	{ defaultValue: () => undefined },
)
