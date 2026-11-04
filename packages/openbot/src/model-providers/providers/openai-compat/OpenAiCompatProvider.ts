import { dual } from "effect/Function"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import { Provider as CoreProvider, Model } from "@openbot-build/core"
import { type AiError } from "effect/ai"
import {
	Array as Arr,
	Effect,
	Layer,
	Context,
	Predicate,
	Schema,
	Record as Rec,
} from "effect"

export type Defaults = Omit<typeof OpenAiLanguageModel.Config.Service, "model">

/** The host gives the client when it builds the selected model. */
export type Provider = CoreProvider.Provider<
	AiError.AiError,
	never,
	OpenAiClient.OpenAiClient
>

/** `upstreamModel` is the model name that the API gets. The default is the selected model ID. */
export interface Options {
	readonly upstreamModel?: string
}

export const make = ({
	upstreamModel,
	...defaults
}: Defaults & Options = {}): Provider =>
	new CoreProvider.Provider({
		id: CoreProvider.Id.make("openai-compat"),
		model: (selection) =>
			Effect.succeed(
				Model.make({
					provider: selection.provider,
					model: selection.model,
					layer: OpenAiLanguageModel.layer({
						model: upstreamModel ?? selection.model,
						config: {
							...defaults,
							...Rec.filter(
								{
									reasoning_effort: selection.reasoningEffort,
									service_tier: selection.serviceTier,
								},
								Predicate.isNotUndefined,
							),
						},
					}),
				}),
			),
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

const isCloudflare = (address: string | undefined) => {
	if (address === undefined || !URL.canParse(address)) return false
	const url = new URL(address)
	return (
		url.origin === "https://api.cloudflare.com" &&
		/^\/client\/v4\/accounts\/[^/]+\/ai\/v1\/?$/.test(url.pathname)
	)
}

type Messages = Parameters<
	OpenAiClient.Service["createResponse"]
>[0]["messages"]

const isToolOnlyAssistant = Schema.is(
	Schema.Struct({
		role: Schema.Literal("assistant"),
		content: Schema.Null,
		tool_calls: Schema.NonEmptyArray(Schema.Unknown),
	}),
)

function cloudflareMessages(messages: Messages): Messages
function cloudflareMessages(messages: unknown): unknown
function cloudflareMessages(messages: unknown): unknown {
	if (!Arr.isArray(messages)) return messages
	return Arr.map(messages, (message) =>
		// Workers AI rejects null content on an assistant tool call with HTTP 400 (code 5006).
		// Its Chat Completions API accepts an empty string for this same message.
		isToolOnlyAssistant(message) ? { ...message, content: "" } : message,
	)
}

/** The host owns the client Layer, endpoint and credentials. */
export const layerClient = (options: OpenAiClient.Options) =>
	Layer.effect(
		OpenAiClient.OpenAiClient,
		Effect.map(OpenAiClient.make(options), (client) =>
			!isCloudflare(options.apiUrl)
				? client
				: OpenAiClient.OpenAiClient.of({
						...client,
						createResponse: (request) =>
							client.createResponse({
								...request,
								messages: cloudflareMessages(request.messages),
							}),
						createResponseStream: (request) =>
							client.createResponseStream({
								...request,
								messages: cloudflareMessages(request["messages"]),
							}),
					}),
		),
	)
