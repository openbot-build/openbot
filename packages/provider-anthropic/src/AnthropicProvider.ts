import { dual } from "effect/Function"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Provider as CoreProvider, Model } from "@openbot-build/core"
import { AiError } from "effect/ai"
import { Effect, Layer, Schema, Context, Predicate, Record } from "effect"

export type Defaults = Omit<
	typeof AnthropicLanguageModel.Config.Service,
	"model"
>

/** The host gives the client when it builds the selected model. */
export type Provider = CoreProvider.Provider<
	AiError.AiError,
	never,
	AnthropicClient.AnthropicClient
>

const invalid = (description: string) =>
	AiError.AiError.make({
		module: "provider-anthropic",
		method: "model",
		reason: AiError.InvalidRequestError.make({ description }),
	})

// The SDK types own these sets. Each object must name every SDK value and
// no other value, so the schemas below stay equal to the SDK types.
const efforts: {
	readonly [
		Key in NonNullable<NonNullable<Defaults["output_config"]>["effort"]>
	]: true
} = { low: true, medium: true, high: true }
const serviceTiers: {
	readonly [Key in NonNullable<Defaults["service_tier"]>]: true
} = { auto: true, standard_only: true }
const Effort = Schema.Literals(Record.keys(efforts))
const ServiceTier = Schema.Literals(Record.keys(serviceTiers))

export const make = (defaults: Defaults = {}): Provider =>
	new CoreProvider.Provider({
		id: CoreProvider.Id.make("anthropic"),
		model: (selection) =>
			Effect.gen(function* () {
				const effort =
					selection.reasoningEffort === undefined
						? defaults.output_config?.effort
						: yield* Schema.decodeUnknownEffect(Effort)(
								selection.reasoningEffort,
							)
				const tier =
					selection.serviceTier === undefined
						? defaults.service_tier
						: yield* Schema.decodeUnknownEffect(ServiceTier)(
								selection.serviceTier,
							)
				const config: Defaults = {
					...defaults,
					...(effort === undefined
						? {}
						: { output_config: { ...defaults.output_config, effort } }),
					...Record.filter({ service_tier: tier }, Predicate.isNotUndefined),
				}
				return Model.make({
					provider: selection.provider,
					model: selection.model,
					layer: AnthropicLanguageModel.layer({
						model: selection.model,
						config,
					}),
				})
			}).pipe(Effect.mapError((error) => invalid(String(error)))),
	})

export const layer: {
	(
		defaults?: Defaults,
	): <I>(tag: Context.Service<I, Provider>) => Layer.Layer<I>
	<I>(tag: Context.Service<I, Provider>, defaults?: Defaults): Layer.Layer<I>
} = dual(
	(args) => Context.isKey(args[0]),
	<I>(tag: Context.Service<I, Provider>, defaults: Defaults = {}) =>
		Layer.succeed(tag, make(defaults)),
)

/** The host owns the client Layer, endpoint and credentials. */
export const layerClient = AnthropicClient.layer
