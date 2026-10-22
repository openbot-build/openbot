import {
	Config,
	Model as CoreModel,
	Provider as CoreProvider,
} from "@openbot-build/core"
import type { ModelProvidersApi } from "@openbot-build/api"
import {
	Context,
	Effect,
	Exit,
	HashMap,
	Layer,
	Option,
	type Redacted,
	Scope,
	SynchronizedRef,
} from "effect"
import { DecisionModel, LanguageModel } from "effect/ai"
import type { HttpClient } from "effect/http"
import * as AnthropicProvider from "../providers/anthropic/AnthropicProvider.ts"
import * as OpenAiCompatProvider from "../providers/openai-compat/OpenAiCompatProvider.ts"
import * as OpenAiProvider from "../providers/openai/OpenAiProvider.ts"
import * as TypeSafeProvider from "../providers/typesafe/TypeSafeProvider.ts"
import { Settings } from "../settings/Settings.ts"
import { linkedOwner, ModelProviders, type Stored } from "./ModelProviders.ts"
import { type Effective, effective, Models, modelKey } from "./Models.ts"

/**
 * Models that the program itself gives, such as the simulated model of the
 * development entry point. The API cannot change them, and every organization can use them.
 */
export interface Builtin {
	readonly providers: ReadonlyArray<Config.Provider>
	readonly models: ReadonlyArray<Config.Model>
	readonly resolve: (
		selection: Config.Selection,
	) => Effect.Effect<
		LanguageModel.LanguageModel,
		Config.ModelConfigurationError
	>
}

export interface Catalog {
	readonly providers: ReadonlyArray<Config.Provider>
	readonly models: ReadonlyArray<Config.Model>
}

/** The models that each organization can use now, built from the stored providers, links and models. */
export class ModelRegistry extends Context.Service<
	ModelRegistry,
	{
		readonly catalog: (
			organizationId: string,
		) => Effect.Effect<Catalog, Config.ModelConfigurationError>
		/** The API form of the catalog, with the default model. */
		readonly view: (
			organizationId: string,
		) => Effect.Effect<
			ModelProvidersApi.ModelCatalog,
			Config.ModelConfigurationError
		>
		/** The default model of a new Session in the organization. */
		readonly defaultSelection: (
			organizationId: string,
		) => Effect.Effect<
			Option.Option<Config.Selection>,
			Config.ModelConfigurationError
		>
		/** Leave out the selection for the default model of the organization. */
		readonly resolve: (
			organizationId: string,
			selection: Config.Selection | undefined,
		) => Effect.Effect<
			LanguageModel.LanguageModel,
			Config.ModelConfigurationError
		>
		/** The helper model of the organization, or its default model. */
		readonly helper: (
			organizationId: string,
		) => Effect.Effect<
			LanguageModel.LanguageModel,
			Config.ModelConfigurationError
		>
		/** The decision model of the organization. None when its settings name none. */
		readonly decision: (
			organizationId: string,
		) => Effect.Effect<
			Option.Option<DecisionModel.DecisionModel>,
			Config.ModelConfigurationError
		>
	}
>()("@openbot-build/openbot/models/ModelRegistry") {}

const unavailable = (message: string) =>
	new Config.ModelConfigurationError({ reason: "unavailable", message })

/** One model that one provider offers, with the values of the link applied. */
interface Offer {
	readonly provider: Stored
	readonly model: Effective
}

const catalogModel = ({ provider, model }: Offer): Config.Model =>
	Config.Model.make({
		provider: CoreProvider.Id.make(provider.id),
		id: CoreModel.Id.make(model.id),
		name: model.name,
		reasoningEfforts: model.reasoningEfforts,
		serviceTiers: model.serviceTiers,
		...(model.contextWindow === null
			? {}
			: { maxContextWindow: model.contextWindow }),
		...(model.maxOutputTokens === null
			? {}
			: { maxOutputTokensLimit: model.maxOutputTokens }),
	})

type ApiKey = Redacted.Redacted<string>

/** The client options of a provider: its key, and its address without a trailing slash. */
const clientOptions = (provider: Stored, apiKey: ApiKey) => ({
	apiKey,
	...(provider.endpoint === null
		? {}
		: { apiUrl: provider.endpoint.replace(/\/$/, "") }),
})

/** The decision model Layer of one provider kind, with its client. */
const decisionLayer = (
	provider: Stored,
	apiKey: ApiKey,
	upstreamModel: string,
) => {
	switch (provider.kind) {
		case "typesafe":
			return Effect.succeed(
				TypeSafeProvider.layer({
					...clientOptions(provider, apiKey),
					upstreamModel,
				}),
			)
		case "openai-compat":
			return Effect.fail(
				new Config.ModelConfigurationError({
					reason: "unsupported-option",
					message:
						"OpenBot cannot ask a decision model through an openai-compat provider yet. Use a typesafe provider.",
				}),
			)
		case "openai":
		case "anthropic":
			return Effect.fail(
				new Config.ModelConfigurationError({
					reason: "unsupported-option",
					message: `A ${provider.kind} provider serves only language models.`,
				}),
			)
	}
}

/** The model Layer of one provider kind, with its client. */
const modelLayer = (
	provider: Stored,
	apiKey: ApiKey,
	selection: Config.Selection,
	upstreamModel: string,
) =>
	Effect.gen(function* () {
		const client = clientOptions(provider, apiKey)
		switch (provider.kind) {
			case "openai": {
				const model = yield* OpenAiProvider.make({ upstreamModel }).model(
					selection,
				)
				return model.pipe(Layer.provide(OpenAiProvider.layerClient(client)))
			}
			case "anthropic": {
				const model = yield* AnthropicProvider.make({ upstreamModel }).model(
					selection,
				)
				return model.pipe(Layer.provide(AnthropicProvider.layerClient(client)))
			}
			case "openai-compat": {
				const model = yield* OpenAiCompatProvider.make({ upstreamModel }).model(
					selection,
				)
				return model.pipe(
					Layer.provide(OpenAiCompatProvider.layerClient(client)),
				)
			}
			case "typesafe":
				return yield* new Config.ModelConfigurationError({
					reason: "unsupported-option",
					message: "A typesafe provider serves only decision models.",
				})
		}
	})

/** Only a language model can run a Session or do the work of the helper model. */
const isLanguage = (offer: Offer) => offer.model.type === "language"

interface Built<A> {
	readonly version: number
	readonly scope: Scope.Closeable
	readonly model: A
}

export const make = (options: { readonly builtin?: Builtin } = {}) =>
	Effect.gen(function* () {
		const providers = yield* ModelProviders
		const models = yield* Models
		const settings = yield* Settings
		const scope = yield* Scope.Scope
		const services = yield* Effect.context<HttpClient.HttpClient>()
		const builtin = options.builtin
		/**
		 * One built model for each provider, model and option. A change to the
		 * provider gives it a new version, so the next call builds it again and
		 * closes the old one.
		 */
		const built = yield* SynchronizedRef.make(
			HashMap.empty<string, Built<LanguageModel.LanguageModel>>(),
		)
		/** The same for decision models. */
		const builtDecisions = yield* SynchronizedRef.make(
			HashMap.empty<string, Built<DecisionModel.DecisionModel>>(),
		)

		/**
		 * Gives the built model for a key from the cache. It builds the model when
		 * the cache has none, or when the provider changed after the last build.
		 */
		const cached = <I, A, E>(
			cache: SynchronizedRef.SynchronizedRef<HashMap.HashMap<string, Built<A>>>,
			key: string,
			provider: Stored,
			tag: Context.Key<I, A>,
			layerOf: (
				apiKey: ApiKey,
			) => Effect.Effect<
				Layer.Layer<I, E, HttpClient.HttpClient>,
				Config.ModelConfigurationError
			>,
		) =>
			SynchronizedRef.modifyEffect(cache, (map) =>
				Effect.gen(function* () {
					const existing = HashMap.get(map, key)
					if (
						Option.isSome(existing) &&
						existing.value.version === provider.version
					)
						return [existing.value.model, map] as const
					if (Option.isSome(existing))
						yield* Scope.close(existing.value.scope, Exit.void)
					const apiKey = yield* providers
						.openKey(provider)
						.pipe(
							Effect.mapError(() =>
								unavailable("OpenBot cannot open the provider key right now."),
							),
						)
					const layer = yield* layerOf(apiKey)
					const entryScope = yield* Scope.fork(scope)
					const context = yield* Layer.buildWithScope(layer, entryScope).pipe(
						Effect.provideContext(services),
						Effect.mapError(() =>
							unavailable("OpenBot cannot start the model right now."),
						),
					)
					const model = Context.get(context, tag)
					return [
						model,
						HashMap.set(map, key, {
							version: provider.version,
							scope: entryScope,
							model,
						}),
					] as const
				}),
			)

		/** The usable providers, and each model that they offer to the organization. */
		const stored = (organizationId: string) =>
			Effect.gen(function* () {
				const list = yield* providers.available(organizationId)
				const usable = new Map(
					(yield* models.available(organizationId)).map(
						(model) => [modelKey(model), model] as const,
					),
				)
				const offers = list.flatMap((provider) =>
					provider.models.flatMap((link): ReadonlyArray<Offer> => {
						const model = usable.get(
							modelKey({
								owner: linkedOwner({ provider, link }),
								id: link.model,
							}),
						)
						return model === undefined
							? []
							: [{ provider, model: effective({ model, link }) }]
					}),
				)
				return { providers: list, offers }
			}).pipe(
				Effect.mapError(() =>
					unavailable("OpenBot cannot read the model providers right now."),
				),
			)

		const catalog = (organizationId: string) =>
			Effect.map(stored(organizationId), (current) => ({
				providers: [
					...(builtin?.providers ?? []),
					...current.providers.map((provider): Config.Provider => ({
						id: CoreProvider.Id.make(provider.id),
						name: provider.name,
						...(provider.endpoint === null
							? {}
							: { endpoint: provider.endpoint }),
					})),
				],
				models: [
					...(builtin?.models ?? []),
					...current.offers.filter(isLanguage).map(catalogModel),
				],
			}))

		const organizationSettings = (organizationId: string) =>
			settings
				.organization(organizationId)
				.pipe(
					Effect.mapError(() =>
						unavailable("OpenBot cannot read the settings right now."),
					),
				)

		const defaultSelection = (organizationId: string) =>
			Effect.gen(function* () {
				const current = yield* organizationSettings(organizationId)
				if (current.document.defaultModel !== null)
					return Option.some(current.document.defaultModel)
				const first = (yield* catalog(organizationId)).models[0]
				return Option.map(Option.fromNullishOr(first), (model) =>
					Config.Selection.make({ provider: model.provider, model: model.id }),
				)
			})

		const build = (
			{ provider, model: offered }: Offer,
			selection: Config.Selection,
		) =>
			Effect.gen(function* () {
				const key = JSON.stringify([
					provider.id,
					selection.model,
					offered.upstream,
					selection.reasoningEffort ?? null,
					selection.serviceTier ?? null,
				])
				return yield* cached(
					built,
					key,
					provider,
					LanguageModel.LanguageModel,
					(apiKey) =>
						modelLayer(provider, apiKey, selection, offered.upstream).pipe(
							Effect.mapError(
								(error) =>
									new Config.ModelConfigurationError({
										reason: "unsupported-option",
										message: String(error),
									}),
							),
						),
				)
			})

		const decision = (organizationId: string) =>
			Effect.gen(function* () {
				const selection = (yield* organizationSettings(organizationId)).document
					.decisionModel
				if (selection === null) return Option.none()
				const offer = (yield* stored(organizationId)).offers.find(
					(offer) =>
						offer.provider.id === selection.provider &&
						offer.model.id === selection.model,
				)
				if (offer === undefined || offer.model.type !== "decision")
					return yield* new Config.ModelConfigurationError({
						reason: "model-not-found",
						message:
							"No provider of the organization offers its decision model now.",
					})
				const key = JSON.stringify([offer.provider.id, offer.model.upstream])
				return Option.some(
					yield* cached(
						builtDecisions,
						key,
						offer.provider,
						DecisionModel.DecisionModel,
						(apiKey) =>
							decisionLayer(offer.provider, apiKey, offer.model.upstream),
					),
				)
			})

		const resolve = (
			organizationId: string,
			requested: Config.Selection | undefined,
		) =>
			Effect.gen(function* () {
				const selection =
					requested ??
					Option.getOrUndefined(yield* defaultSelection(organizationId))
				if (selection === undefined)
					return yield* unavailable("The organization has no model.")
				if (
					builtin !== undefined &&
					builtin.providers.some(
						(provider) => provider.id === selection.provider,
					)
				)
					return yield* builtin.resolve(selection)
				const current = yield* stored(organizationId)
				if (
					!current.providers.some(
						(provider) => provider.id === selection.provider,
					)
				)
					return yield* new Config.ModelConfigurationError({
						reason: "provider-not-found",
						message: "The organization cannot use this model provider.",
					})
				const offer = current.offers.find(
					(offer) =>
						offer.provider.id === selection.provider &&
						offer.model.id === selection.model,
				)
				if (offer === undefined)
					return yield* new Config.ModelConfigurationError({
						reason: "model-not-found",
						message: "The model provider does not offer this model.",
					})
				if (!isLanguage(offer))
					return yield* new Config.ModelConfigurationError({
						reason: "model-not-found",
						message: "This is a decision model. It cannot write text.",
					})
				if (
					(selection.reasoningEffort !== undefined &&
						!offer.model.reasoningEfforts.includes(
							selection.reasoningEffort,
						)) ||
					(selection.serviceTier !== undefined &&
						!offer.model.serviceTiers.includes(selection.serviceTier))
				)
					return yield* new Config.ModelConfigurationError({
						reason: "unsupported-option",
						message:
							"The model does not offer this reasoning effort or service tier.",
					})
				return yield* build(offer, selection)
			})

		return ModelRegistry.of({
			catalog,
			defaultSelection,
			view: (organizationId) =>
				Effect.gen(function* () {
					const current = yield* stored(organizationId)
					return {
						providers: [
							...(builtin?.providers ?? []).map((provider) => ({
								id: provider.id,
								owner: "platform" as const,
								kind: "openai-compat" as const,
								name: provider.name,
							})),
							...current.providers.map((provider) => ({
								id: provider.id,
								owner: provider.owner.kind,
								kind: provider.kind,
								name: provider.name,
							})),
						],
						models: [
							...(builtin?.models ?? []).map((model) => ({
								provider: model.provider,
								id: model.id,
								owner: "platform" as const,
								type: "language" as const,
								name: model.name,
								reasoningEfforts: model.reasoningEfforts,
								serviceTiers: model.serviceTiers,
								...(model.maxContextWindow === undefined
									? {}
									: { contextWindow: model.maxContextWindow }),
								...(model.maxOutputTokensLimit === undefined
									? {}
									: { maxOutputTokens: model.maxOutputTokensLimit }),
							})),
							...current.offers.map(({ provider, model }) => ({
								provider: provider.id,
								id: model.id,
								owner: model.owner,
								type: model.type,
								name: model.name,
								reasoningEfforts: model.reasoningEfforts,
								serviceTiers: model.serviceTiers,
								...(model.contextWindow === null
									? {}
									: { contextWindow: model.contextWindow }),
								...(model.maxOutputTokens === null
									? {}
									: { maxOutputTokens: model.maxOutputTokens }),
							})),
						],
						defaultModel: Option.getOrNull(
							yield* defaultSelection(organizationId),
						),
						decisionModel: (yield* organizationSettings(organizationId))
							.document.decisionModel,
					}
				}),
			resolve,
			decision,
			helper: (organizationId) =>
				Effect.gen(function* () {
					const current = yield* organizationSettings(organizationId)
					return yield* resolve(
						organizationId,
						current.document.helperModel ?? undefined,
					)
				}),
		})
	})

export const layer = (options: { readonly builtin?: Builtin } = {}) =>
	Layer.effect(ModelRegistry, make(options))
