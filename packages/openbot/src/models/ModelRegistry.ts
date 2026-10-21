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
	Scope,
	SynchronizedRef,
} from "effect"
import { LanguageModel } from "effect/ai"
import type { HttpClient } from "effect/http"
import * as AnthropicProvider from "../providers/anthropic/AnthropicProvider.ts"
import * as OpenAiCompatProvider from "../providers/openai-compat/OpenAiCompatProvider.ts"
import * as OpenAiProvider from "../providers/openai/OpenAiProvider.ts"
import { Settings } from "../settings/Settings.ts"
import { ModelProviders, type Stored } from "./ModelProviders.ts"

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

/** The models that each organization can use now, built from the stored providers. */
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
	}
>()("@openbot-build/openbot/models/ModelRegistry") {}

const unavailable = (message: string) =>
	new Config.ModelConfigurationError({ reason: "unavailable", message })

const catalogModel = (
	provider: Stored,
	entry: ModelProvidersApi.ModelEntry,
): Config.Model =>
	Config.Model.make({
		provider: CoreProvider.Id.make(provider.id),
		id: CoreModel.Id.make(entry.id),
		name: entry.name,
		reasoningEfforts: entry.reasoningEfforts,
		serviceTiers: entry.serviceTiers,
		...(entry.contextWindow === undefined
			? {}
			: { maxContextWindow: entry.contextWindow }),
		...(entry.maxOutputTokens === undefined
			? {}
			: { maxOutputTokensLimit: entry.maxOutputTokens }),
	})

/** The model Layer of one provider kind, with its client. */
const modelLayer = (
	provider: Stored,
	apiKey: Parameters<typeof OpenAiProvider.layerClient>[0]["apiKey"],
	selection: Config.Selection,
) =>
	Effect.gen(function* () {
		const apiUrl =
			provider.endpoint === null
				? undefined
				: provider.endpoint.replace(/\/$/, "")
		const client = { apiKey, ...(apiUrl === undefined ? {} : { apiUrl }) }
		switch (provider.kind) {
			case "openai": {
				const model = yield* OpenAiProvider.make().model(selection)
				return model.pipe(Layer.provide(OpenAiProvider.layerClient(client)))
			}
			case "anthropic": {
				const model = yield* AnthropicProvider.make().model(selection)
				return model.pipe(Layer.provide(AnthropicProvider.layerClient(client)))
			}
			case "openai-compat": {
				const model = yield* OpenAiCompatProvider.make().model(selection)
				return model.pipe(
					Layer.provide(OpenAiCompatProvider.layerClient(client)),
				)
			}
		}
	})

interface Built {
	readonly version: number
	readonly scope: Scope.Closeable
	readonly model: LanguageModel.LanguageModel
}

export const make = (options: { readonly builtin?: Builtin } = {}) =>
	Effect.gen(function* () {
		const providers = yield* ModelProviders
		const settings = yield* Settings
		const scope = yield* Scope.Scope
		const services = yield* Effect.context<HttpClient.HttpClient>()
		const builtin = options.builtin
		/**
		 * One built model for each provider, model and option. A change to the
		 * provider gives it a new version, so the next call builds it again and
		 * closes the old one.
		 */
		const built = yield* SynchronizedRef.make(HashMap.empty<string, Built>())

		const stored = (organizationId: string) =>
			providers
				.available(organizationId)
				.pipe(
					Effect.mapError(() =>
						unavailable("OpenBot cannot read the model providers right now."),
					),
				)

		const catalog = (organizationId: string) =>
			Effect.map(stored(organizationId), (list) => ({
				providers: [
					...(builtin?.providers ?? []),
					...list.map((provider): Config.Provider => ({
						id: CoreProvider.Id.make(provider.id),
						name: provider.name,
						...(provider.endpoint === null
							? {}
							: { endpoint: provider.endpoint }),
					})),
				],
				models: [
					...(builtin?.models ?? []),
					...list.flatMap((provider) =>
						provider.models.map((entry) => catalogModel(provider, entry)),
					),
				],
			}))

		const defaultSelection = (organizationId: string) =>
			Effect.gen(function* () {
				const current = yield* settings
					.organization(organizationId)
					.pipe(
						Effect.mapError(() =>
							unavailable("OpenBot cannot read the settings right now."),
						),
					)
				if (current.document.defaultModel !== null)
					return Option.some(current.document.defaultModel)
				const first = (yield* catalog(organizationId)).models[0]
				return Option.map(Option.fromNullishOr(first), (model) =>
					Config.Selection.make({ provider: model.provider, model: model.id }),
				)
			})

		const build = (provider: Stored, selection: Config.Selection) =>
			Effect.gen(function* () {
				const key = JSON.stringify([
					provider.id,
					selection.model,
					selection.reasoningEffort ?? null,
					selection.serviceTier ?? null,
				])
				return yield* SynchronizedRef.modifyEffect(built, (map) =>
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
									unavailable(
										"OpenBot cannot open the provider key right now.",
									),
								),
							)
						const layer = yield* modelLayer(provider, apiKey, selection).pipe(
							Effect.mapError(
								(error) =>
									new Config.ModelConfigurationError({
										reason: "unsupported-option",
										message: String(error),
									}),
							),
						)
						const entryScope = yield* Scope.fork(scope)
						const context = yield* Layer.buildWithScope(layer, entryScope).pipe(
							Effect.provideContext(services),
							Effect.mapError(() =>
								unavailable("OpenBot cannot start the model right now."),
							),
						)
						const model = Context.get(context, LanguageModel.LanguageModel)
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
				const provider = (yield* stored(organizationId)).find(
					(provider) => provider.id === selection.provider,
				)
				if (provider === undefined)
					return yield* new Config.ModelConfigurationError({
						reason: "provider-not-found",
						message: "The organization cannot use this model provider.",
					})
				const entry = provider.models.find(
					(model) => model.id === selection.model,
				)
				if (entry === undefined)
					return yield* new Config.ModelConfigurationError({
						reason: "model-not-found",
						message: "The model provider does not offer this model.",
					})
				if (
					(selection.reasoningEffort !== undefined &&
						!entry.reasoningEfforts.includes(selection.reasoningEffort)) ||
					(selection.serviceTier !== undefined &&
						!entry.serviceTiers.includes(selection.serviceTier))
				)
					return yield* new Config.ModelConfigurationError({
						reason: "unsupported-option",
						message:
							"The model does not offer this reasoning effort or service tier.",
					})
				return yield* build(provider, selection)
			})

		return ModelRegistry.of({
			catalog,
			defaultSelection,
			view: (organizationId) =>
				Effect.gen(function* () {
					const list = yield* stored(organizationId)
					const current = yield* catalog(organizationId)
					return {
						providers: [
							...(builtin?.providers ?? []).map((provider) => ({
								id: provider.id,
								owner: "platform" as const,
								kind: "openai-compat" as const,
								name: provider.name,
							})),
							...list.map((provider) => ({
								id: provider.id,
								owner: provider.owner.kind,
								kind: provider.kind,
								name: provider.name,
							})),
						],
						models: current.models.map((model) => ({
							provider: model.provider,
							id: model.id,
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
						defaultModel: Option.getOrNull(
							yield* defaultSelection(organizationId),
						),
					}
				}),
			resolve,
			helper: (organizationId) =>
				Effect.gen(function* () {
					const current = yield* settings
						.organization(organizationId)
						.pipe(
							Effect.mapError(() =>
								unavailable("OpenBot cannot read the settings right now."),
							),
						)
					return yield* resolve(
						organizationId,
						current.document.helperModel ?? undefined,
					)
				}),
		})
	})

export const layer = (options: { readonly builtin?: Builtin } = {}) =>
	Layer.effect(ModelRegistry, make(options))
