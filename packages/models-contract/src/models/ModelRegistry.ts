import { Config, type Live } from "@openbot-build/core"
import type { Models as ModelsModel } from "@openbot-build/domain"
import { Context, Data, Effect, Option } from "effect"
import { DecisionModel, LanguageModel } from "effect/ai"

export interface Catalog {
	readonly providers: ReadonlyArray<Config.Provider>
	readonly models: ReadonlyArray<Config.Model>
}

/** A model of either type, for a use that can take both. */
export type AnyModel = Data.TaggedEnum<{
	Language: { readonly model: LanguageModel.LanguageModel }
	Decision: { readonly model: DecisionModel.DecisionModel }
}>

export const AnyModel = Data.taggedEnum<AnyModel>()

/** A Live model, and how to meter the model calls of its Turns. */
export interface ResolvedLive {
	readonly model: Live.LiveModel
	readonly meter: (
		model: LanguageModel.LanguageModel,
	) => LanguageModel.LanguageModel
}

/** The models that each organization can use now, built from the stored providers, links and models. */
export class ModelRegistry extends Context.Service<
	ModelRegistry,
	{
		/** Only the built-in model adapter can supply a default. */
		readonly defaultModel: Option.Option<Config.Selection>
		readonly catalog: (
			organizationId: string,
		) => Effect.Effect<Catalog, Config.ModelConfigurationError>
		/** The API form of the catalog. */
		readonly view: (
			organizationId: string,
		) => Effect.Effect<ModelsModel.ModelCatalog, Config.ModelConfigurationError>
		readonly resolve: (
			organizationId: string,
			selection: Config.Selection,
		) => Effect.Effect<
			LanguageModel.LanguageModel,
			Config.ModelConfigurationError
		>
		/** Read the current helper selection when a step needs it. */
		readonly helperSelection: (
			organizationId: string,
			name: "rulesModel" | "botMemoryModel",
		) => Effect.Effect<Config.Selection, Config.ModelConfigurationError>
		readonly resolveAny: (
			organizationId: string,
			selection: Config.Selection,
		) => Effect.Effect<AnyModel, Config.ModelConfigurationError>
		/**
		 * The model that judges Rules. It can be a language model or a decision
		 * model. It fails when the organization has none.
		 */
		readonly rulesModel: (
			organizationId: string,
		) => Effect.Effect<AnyModel, Config.ModelConfigurationError>
		/** The model that learns Bot memory. It fails when the organization has none. */
		readonly botMemoryModel: (
			organizationId: string,
		) => Effect.Effect<
			LanguageModel.LanguageModel,
			Config.ModelConfigurationError
		>
		/**
		 * The Live models that the organization can use now, for live Chats. A model is
		 * in the list only when a Live backend serves the kind of its provider.
		 */
		readonly liveCatalog: (
			organizationId: string,
		) => Effect.Effect<Catalog, Config.ModelConfigurationError>
		/** The Live model that a selection names. It fails when it is not a usable Live model. */
		readonly resolveLive: (
			organizationId: string,
			selection: Config.Selection,
		) => Effect.Effect<ResolvedLive, Config.ModelConfigurationError>
		/** Meter a remote Live model without opening a provider key or connection. */
		readonly meterLive: (
			organizationId: string,
			selection: Config.Selection,
			model: LanguageModel.LanguageModel,
		) => Effect.Effect<
			LanguageModel.LanguageModel,
			Config.ModelConfigurationError
		>
		/**
		 * The decision model that a selection names. It fails when no provider of
		 * the organization offers it, or when it is not a `decision` model.
		 */
		readonly decision: (
			organizationId: string,
			selection: Config.Selection,
		) => Effect.Effect<
			DecisionModel.DecisionModel,
			Config.ModelConfigurationError
		>
	}
	// @effect-diagnostics-next-line deterministicKeys:off -- The key keeps the name it had in the openbot package, so code built for that name still finds this service.
>()("@openbot-build/openbot/models-contract/models/ModelRegistry") {}
