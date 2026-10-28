import { AiError } from "effect/ai"
import { ProviderOAuth } from "./ProviderOAuth.ts"
import * as ChatGptProvider from "../providers/chatgpt/ChatGptProvider.ts"
import {
	Config,
	type Live,
	Model as CoreModel,
	Provider as CoreProvider,
} from "@openbot-build/core"
import type {
	Billing as BillingModel,
	Models as ModelsModel,
} from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Context,
	Data,
	Duration,
	Effect,
	Equal,
	Hash,
	HashMap,
	Layer,
	Option,
	pipe,
	RcMap,
	type Redacted,
	String as Str,
} from "effect"
import { DecisionModel, LanguageModel, Telemetry } from "effect/ai"
import { HttpClient } from "effect/http"
import * as Failures from "../errors/Failures.ts"
import * as Report from "../errors/Report.ts"
import * as AnthropicProvider from "../providers/anthropic/AnthropicProvider.ts"
import * as OpenAiCompatProvider from "../providers/openai-compat/OpenAiCompatProvider.ts"
import * as OpenAiProvider from "../providers/openai/OpenAiProvider.ts"
import * as TypeSafeProvider from "../providers/typesafe/TypeSafeProvider.ts"
import { Billing } from "../billing/Billing.ts"
import { meter, meterDecision } from "../billing/MeteredModel.ts"
import { TokenThrottle } from "../billing/TokenThrottle.ts"
import { Settings } from "../settings/Settings.ts"
import { linkedOwner, ModelProviders, type Stored } from "./ModelProviders.ts"
import { type Effective, effective, Models, modelKey } from "./Models.ts"
import * as ToolImages from "../providers/ToolImages.ts"
import * as LiveBackends from "./LiveBackends.ts"

/**
 * Models that the program itself gives, such as the simulated model of the
 * development entry point. The API cannot change them, and every organization can use them.
 */
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
>()("@openbot-build/openbot/models/ModelRegistry") {}

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
		: { apiUrl: pipe(provider.endpoint, Str.replace(/\/$/, "")) }),
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
				Config.ModelConfigurationError.make({
					reason: "unsupported-option",
					message:
						"OpenBot cannot ask a decision model through an openai-compat provider yet. Use a typesafe provider.",
				}),
			)
		case "openai":
		case "anthropic":
		case "chatgpt":
			return Effect.fail(
				Config.ModelConfigurationError.make({
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
				return model.pipe(
					Layer.provide(
						OpenAiProvider.layerClient({
							...client,
							transformClient: ToolImages.transformClient("openai"),
						}),
					),
				)
			}
			case "anthropic": {
				const model = yield* AnthropicProvider.make({ upstreamModel }).model(
					selection,
				)
				return model.pipe(
					Layer.provide(
						AnthropicProvider.layerClient({
							...client,
							transformClient: ToolImages.transformClient("anthropic"),
						}),
					),
				)
			}
			case "openai-compat": {
				const model = yield* OpenAiCompatProvider.make({ upstreamModel }).model(
					selection,
				)
				return model.pipe(
					Layer.provide(OpenAiCompatProvider.layerClient(client)),
				)
			}
			case "chatgpt":
			case "typesafe":
				return yield* Config.ModelConfigurationError.make({
					reason: "unsupported-option",
					message: "A typesafe provider serves only decision models.",
				})
		}
	})

/**
 * The key of one built model. Two keys with the same `values` are the same
 * key. The values start with the ID and the version of the provider, so a
 * changed provider gets a new entry. `input` is what the build needs.
 */
class Key<Input> implements Equal.Equal {
	readonly provider: Stored
	readonly input: Input
	readonly values: ReadonlyArray<string | number | null>
	constructor(
		provider: Stored,
		input: Input,
		values: ReadonlyArray<string | null>,
	) {
		this.provider = provider
		this.input = input
		this.values = [provider.id, provider.version, ...values]
	}
	[Equal.symbol](that: Equal.Equal): boolean {
		return that instanceof Key && Equal.equals(this.values, that.values)
	}
	[Hash.symbol](): number {
		return Hash.hash(this.values)
	}
}

/** What the build of a language model needs. */
interface LanguageInput {
	readonly selection: Config.Selection
	readonly upstream: string
}

export const make = (options: { readonly builtin?: Builtin } = {}) =>
	Effect.gen(function* () {
		const providers = yield* ModelProviders
		const oauth = yield* ProviderOAuth
		const models = yield* Models
		const settings = yield* Settings
		const report = yield* Report.make
		// The provider layers are built later, for each model, with this client.
		const httpClient = yield* HttpClient.HttpClient
		const builtin = options.builtin
		const keyUnavailable = Failures.replace(
			"The key of a model provider could not be opened",
			() =>
				Config.ModelConfigurationError.make({
					reason: "unavailable",
					message: "OpenBot cannot open the provider key right now.",
				}),
		)
		const spanTransformer = Option.getOrUndefined(
			Context.getOption(
				yield* Effect.context<never>(),
				Telemetry.CurrentSpanTransformer,
			),
		)
		const billing = yield* Billing
		const throttle = yield* TokenThrottle
		const liveBackends = yield* LiveBackends.LiveBackends
		const metered =
			(call: {
				readonly organizationId: string
				readonly providerId: string
				readonly providerOwner: "platform" | "organization"
				readonly modelId: string
			}) =>
			(model: LanguageModel.LanguageModel) =>
				meter(model, call, { billing, throttle, report, spanTransformer })
		/**
		 * The built models of one type. A key builds its model on first use, and
		 * the model closes after ten minutes without a call. The build of one key
		 * does not wait for other keys. A failed build is not kept, so the next
		 * call builds again. A call borrows the model only for the look-up. That
		 * is safe, because the provider layers hold no scoped resources, and each
		 * model call looks the model up again.
		 */
		const builtModels = <Input, I, A, E>(
			tag: Context.Key<I, A>,
			layerOf: (
				key: Key<Input>,
			) => Effect.Effect<
				Layer.Layer<I, E, HttpClient.HttpClient>,
				Config.ModelConfigurationError
			>,
		) =>
			Effect.gen(function* () {
				const map: RcMap.RcMap<
					Key<Input>,
					A,
					Config.ModelConfigurationError
				> = yield* RcMap.make({
					lookup: (key: Key<Input>) =>
						Effect.gen(function* () {
							const layer = yield* layerOf(key)
							const context = yield* Layer.build(layer).pipe(
								Effect.provideService(HttpClient.HttpClient, httpClient),
								Failures.replace("A model could not start", () =>
									Config.ModelConfigurationError.make({
										reason: "unavailable",
										message: "OpenBot cannot start the model right now.",
									}),
								),
							)
							return Context.get(context, tag)
						}).pipe(
							Effect.onError((cause) =>
								Cause.hasInterruptsOnly(cause)
									? Effect.void
									: RcMap.invalidate(map, key),
							),
						),
					idleTimeToLive: Duration.minutes(10),
				})
				return (key: Key<Input>) => Effect.scoped(RcMap.get(map, key))
			})

		/** One built language model for each version of a provider, model and option. */
		const languageModels = yield* builtModels(
			LanguageModel.LanguageModel,
			(key: Key<LanguageInput>) =>
				Effect.gen(function* (): Effect.fn.Return<
					Layer.Layer<
						LanguageModel.LanguageModel,
						AiError.AiError,
						HttpClient.HttpClient
					>,
					AiError.AiError | Config.ModelConfigurationError
				> {
					if (key.provider.kind === "chatgpt")
						return yield* Effect.succeed(
							ChatGptProvider.layer(key.input.selection, {
								upstreamModel: key.input.upstream,
								onUnauthorized: (token) =>
									oauth
										.invalidate(key.provider.id, token)
										.pipe(
											Failures.replace(
												"Could not change the provider sign-in state",
												() =>
													AiError.AiError.make({
														module: "ChatGptProvider",
														method: "invalidate",
														reason: AiError.UnknownError.make({
															description:
																"Could not change the provider sign-in state.",
														}),
													}),
											),
										),
								accessToken: oauth.accessToken(key.provider.id).pipe(
									Failures.map("Could not read the provider token", (error) =>
										AiError.AiError.make({
											module: "ChatGptProvider",
											method: "accessToken",
											reason:
												error._tag === "ModelProviderLoginRequired"
													? AiError.AuthenticationError.make({
															kind: "MissingKey",
															description:
																"Sign in to ChatGPT for this provider.",
														})
													: AiError.UnknownError.make({
															description: "Could not read the provider token.",
														}),
										}),
									),
								),
							}),
						)
					return yield* providers.openKey(key.provider).pipe(
						keyUnavailable,
						Effect.flatMap((apiKey) =>
							modelLayer(
								key.provider,
								apiKey,
								key.input.selection,
								key.input.upstream,
							),
						),
					)
				}).pipe(
					// The provider cannot make this model, for example for a bad option.
					Failures.replaceTag(
						"AiError",
						"The provider could not use the model options",
						() =>
							Config.ModelConfigurationError.make({
								reason: "unsupported-option",
								message: "The provider does not support these model options.",
							}),
					),
				),
		)
		/** One built decision model for each version of a provider and upstream model. */
		const decisionModels = yield* builtModels(
			DecisionModel.DecisionModel,
			(key: Key<string>) =>
				providers.openKey(key.provider).pipe(
					keyUnavailable,
					Effect.flatMap((apiKey) =>
						decisionLayer(key.provider, apiKey, key.input),
					),
				),
		)

		/** The usable providers, and each model that they offer to the organization. */
		const stored = (organizationId: string) =>
			Effect.gen(function* () {
				const list = yield* providers.available(organizationId)
				const usable = HashMap.fromIterable(
					Arr.map(
						yield* models.available(organizationId),
						(model) => [modelKey(model), model] as const,
					),
				)
				const offers = Arr.flatMap(list, (provider) =>
					Arr.flatMap(provider.models, (link) =>
						pipe(
							HashMap.get(
								usable,
								modelKey({
									owner: linkedOwner({ provider, link }),
									id: link.model,
								}),
							),
							Option.map((model): Offer => ({
								provider,
								model: effective({ model, link }),
							})),
							Arr.fromOption,
						),
					),
				)
				return { providers: list, offers }
			}).pipe(
				Failures.replace("The model providers could not be read", () =>
					Config.ModelConfigurationError.make({
						reason: "unavailable",
						message: "OpenBot cannot read the model providers right now.",
					}),
				),
			)

		const catalog = (organizationId: string) =>
			Effect.map(stored(organizationId), (current) => ({
				providers: [
					...(builtin?.providers ?? []),
					...Arr.map(current.providers, (provider): Config.Provider => ({
						id: CoreProvider.Id.make(provider.id),
						name: provider.name,
						...(provider.endpoint === null
							? {}
							: { endpoint: provider.endpoint }),
					})),
				],
				models: [
					...(builtin?.models ?? []),
					...pipe(
						current.offers,
						Arr.filter((offer) => offer.model.type === "language"),
						Arr.map(catalogModel),
					),
				],
			}))

		const organizationSettings = (organizationId: string) =>
			settings.organization(organizationId).pipe(
				Failures.replace(
					"The settings of an organization could not be read",
					() =>
						Config.ModelConfigurationError.make({
							reason: "unavailable",
							message: "OpenBot cannot read the settings right now.",
						}),
				),
			)

		const build = (
			{ provider, model: offered }: Offer,
			selection: Config.Selection,
		) =>
			languageModels(
				new Key(provider, { selection, upstream: offered.upstream }, [
					selection.model,
					offered.upstream,
					selection.reasoningEffort ?? null,
					selection.serviceTier ?? null,
				]),
			)

		const decision = (organizationId: string, selection: Config.Selection) =>
			Effect.gen(function* () {
				const found = Arr.findFirst(
					(yield* stored(organizationId)).offers,
					(offer) =>
						offer.provider.id === selection.provider &&
						offer.model.id === selection.model,
				)
				if (Option.isNone(found))
					return yield* Config.ModelConfigurationError.make({
						reason: "model-not-found",
						message: "No provider of the organization offers this model.",
					})
				const offer = found.value
				if (offer.model.type !== "decision")
					return yield* Config.ModelConfigurationError.make({
						reason: "model-not-found",
						message: "This is a language model, not a decision model.",
					})
				return meterDecision(
					yield* decisionModels(
						new Key(offer.provider, offer.model.upstream, [
							offer.model.upstream,
						]),
					),
					{
						organizationId,
						providerId: offer.provider.id,
						providerOwner: offer.provider.owner.kind,
						modelId: offer.model.id,
					},
					{ billing, throttle, report },
				)
			})

		const resolve = (organizationId: string, selection: Config.Selection) =>
			Effect.gen(function* () {
				if (
					builtin !== undefined &&
					Arr.some(
						builtin.providers,
						(provider) => provider.id === selection.provider,
					)
				)
					return yield* builtin.resolve(selection).pipe(
						Effect.map(
							metered({
								organizationId,
								providerId: selection.provider,
								providerOwner: "platform",
								modelId: selection.model,
							}),
						),
					)
				const current = yield* stored(organizationId)
				if (
					!Arr.some(
						current.providers,
						(provider) => provider.id === selection.provider,
					)
				)
					return yield* Config.ModelConfigurationError.make({
						reason: "provider-not-found",
						message: "The organization cannot use this model provider.",
					})
				const found = Arr.findFirst(
					current.offers,
					(offer) =>
						offer.provider.id === selection.provider &&
						offer.model.id === selection.model,
				)
				if (Option.isNone(found))
					return yield* Config.ModelConfigurationError.make({
						reason: "model-not-found",
						message: "The model provider does not offer this model.",
					})
				const offer = found.value
				if (offer.model.type !== "language")
					return yield* Config.ModelConfigurationError.make({
						reason: "model-not-found",
						message: `This is a ${offer.model.type} model. It cannot write text.`,
					})
				if (
					(selection.reasoningEffort !== undefined &&
						!offer.model.reasoningEfforts.includes(
							selection.reasoningEffort,
						)) ||
					(selection.serviceTier !== undefined &&
						!offer.model.serviceTiers.includes(selection.serviceTier))
				)
					return yield* Config.ModelConfigurationError.make({
						reason: "unsupported-option",
						message:
							"The model does not offer this reasoning effort or service tier.",
					})
				// The built model is shared by every organization, so each call wraps it again.
				return metered({
					organizationId,
					providerId: offer.provider.id,
					providerOwner: offer.provider.owner.kind,
					modelId: offer.model.id,
				})(yield* build(offer, selection))
			})

		/** Live offers that a Live backend serves. */
		const isLive = (offer: Offer) =>
			offer.model.type === "live" &&
			Option.isSome(liveBackends.get(offer.provider.kind))

		const liveCatalog = (organizationId: string) =>
			Effect.map(stored(organizationId), (current) => {
				const offers = Arr.filter(current.offers, isLive)
				return {
					providers: pipe(
						current.providers,
						Arr.filter((provider) =>
							Arr.some(offers, (offer) => offer.provider.id === provider.id),
						),
						Arr.map((provider): Config.Provider => ({
							id: CoreProvider.Id.make(provider.id),
							name: provider.name,
							...(provider.endpoint === null
								? {}
								: { endpoint: provider.endpoint }),
						})),
					),
					models: Arr.map(offers, catalogModel),
				}
			})

		const liveOffer = (organizationId: string, selection: Config.Selection) =>
			Effect.gen(function* () {
				const found = Arr.findFirst(
					(yield* stored(organizationId)).offers,
					(offer) =>
						offer.model.type === "live" &&
						offer.provider.id === selection.provider &&
						offer.model.id === selection.model,
				)
				if (Option.isNone(found))
					return yield* Config.ModelConfigurationError.make({
						reason: "model-not-found",
						message: "The organization has no Live model with this name.",
					})
				const offer = found.value
				const backend = liveBackends.get(offer.provider.kind)
				if (Option.isNone(backend))
					return yield* Config.ModelConfigurationError.make({
						reason: "unsupported-option",
						message: `OpenBot has no Live backend for ${offer.provider.kind} providers.`,
					})
				return { offer, backend: backend.value }
			})
		const meterLive = (
			organizationId: string,
			selection: Config.Selection,
			model: LanguageModel.LanguageModel,
		) =>
			Effect.map(liveOffer(organizationId, selection), ({ offer }) =>
				metered({
					organizationId,
					providerId: offer.provider.id,
					providerOwner: offer.provider.owner.kind,
					modelId: offer.model.id,
				})(model),
			)
		const resolveLive = (organizationId: string, selection: Config.Selection) =>
			Effect.gen(function* () {
				const { offer, backend } = yield* liveOffer(organizationId, selection)
				const apiKey = yield* providers
					.openKey(offer.provider)
					.pipe(keyUnavailable)
				const model = yield* backend
					.make({
						provider: offer.provider,
						apiKey,
						upstreamModel: offer.model.upstream,
						providerId: CoreProvider.Id.make(offer.provider.id),
						modelId: CoreModel.Id.make(offer.model.id),
					})
					.pipe(
						// Only a model that the backend does not support is a bad option.
						// Any other failure, such as of the provider, says that it is not
						// there now.
						Failures.map("The Live model could not start", (error) =>
							Config.ModelConfigurationError.make({
								reason:
									error.reason === "unsupported"
										? "unsupported-option"
										: "unavailable",
								message:
									error.reason === "unsupported"
										? "The provider does not support this Live model."
										: "OpenBot cannot start the Live model right now.",
							}),
						),
					)
				return {
					model,
					meter: metered({
						organizationId,
						providerId: offer.provider.id,
						providerOwner: offer.provider.owner.kind,
						modelId: offer.model.id,
					}),
				}
			})

		/** The selection that one setting of the organization names. */
		const setting = (
			organizationId: string,
			name: "rulesModel" | "botMemoryModel",
		) =>
			Effect.gen(function* () {
				const selection = (yield* organizationSettings(organizationId))
					.document[name]
				if (selection === null)
					return yield* Config.ModelConfigurationError.make({
						reason: "missing",
						message: `The organization has no ${name}.`,
					})
				return selection
			})

		/** The model that a selection names, as the type that its offer has. */
		const resolveAny = (organizationId: string, selection: Config.Selection) =>
			Effect.gen(function* () {
				const offer = Arr.findFirst(
					(yield* stored(organizationId)).offers,
					(offer) =>
						offer.provider.id === selection.provider &&
						offer.model.id === selection.model,
				)
				return Option.exists(offer, (offer) => offer.model.type === "decision")
					? AnyModel.Decision({
							model: yield* decision(organizationId, selection),
						})
					: AnyModel.Language({
							model: yield* resolve(organizationId, selection),
						})
			})

		return ModelRegistry.of({
			defaultModel: Option.fromUndefinedOr(builtin?.defaultModel),
			catalog,
			view: (organizationId) =>
				Effect.gen(function* () {
					const current = yield* stored(organizationId)
					// The catalog is still useful without its prices.
					const prices = yield* billing
						.currentPrices(
							Arr.map(current.providers, (provider) => provider.id),
						)
						.pipe(
							Effect.tapCauseIf(Cause.hasFails, (cause) =>
								report("The prices of the models could not be read", cause),
							),
							Effect.orElseSucceed(() =>
								HashMap.empty<
									readonly [providerId: string, modelId: string],
									BillingModel.ModelPrice
								>(),
							),
						)
					return {
						providers: [
							...Arr.map(builtin?.providers ?? [], (provider) => ({
								id: CoreProvider.Id.make(provider.id),
								owner: "platform" as const,
								kind: "openai-compat" as const,
								name: provider.name,
							})),
							...Arr.map(current.providers, (provider) => ({
								id: CoreProvider.Id.make(provider.id),
								owner: provider.owner.kind,
								kind: provider.kind,
								name: provider.name,
							})),
						],
						models: [
							...Arr.map(builtin?.models ?? [], (model) => ({
								provider: CoreProvider.Id.make(model.provider),
								id: CoreModel.Id.make(model.id),
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
							...Arr.map(current.offers, ({ provider, model }) => ({
								provider: CoreProvider.Id.make(provider.id),
								id: CoreModel.Id.make(model.id),
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
								...Option.match(HashMap.get(prices, [provider.id, model.id]), {
									onNone: () => ({}),
									onSome: (price) => ({ price }),
								}),
							})),
						],
					}
				}),
			resolve,
			helperSelection: setting,
			resolveAny,
			liveCatalog,
			resolveLive,
			meterLive,
			decision,
			rulesModel: (organizationId) =>
				setting(organizationId, "rulesModel").pipe(
					Effect.flatMap((selection) => resolveAny(organizationId, selection)),
				),
			botMemoryModel: (organizationId) =>
				setting(organizationId, "botMemoryModel").pipe(
					Effect.flatMap((selection) => resolve(organizationId, selection)),
				),
		})
	})

export const layer = (options: { readonly builtin?: Builtin } = {}) =>
	Layer.effect(ModelRegistry, make(options))
