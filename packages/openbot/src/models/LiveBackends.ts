import type { Live, Model, Provider } from "@openbot-build/core"
import type { ModelProvidersApi } from "@openbot-build/api"
import {
	Context,
	HashMap,
	Layer,
	Option,
	type Effect,
	type Redacted,
} from "effect"
import type { Stored } from "./ModelProviders.ts"

/**
 * A Live backend makes Live models for one provider kind, such as OpenAI Realtime for
 * `openai`. To add a backend, write one module with a `LiveBackend` and give it to
 * `layer`. Nothing else in OpenBot needs to change.
 */
export interface LiveBackend {
	readonly kind: ModelProvidersApi.ProviderKind
	readonly make: (input: {
		readonly provider: Stored
		readonly apiKey: Redacted.Redacted<string>
		/** The name of the model at the provider. */
		readonly upstreamModel: string
		readonly providerId: Provider.Id
		readonly modelId: Model.Id
	}) => Effect.Effect<Live.LiveModel, Live.LiveError>
}

export class LiveBackends extends Context.Service<
	LiveBackends,
	{
		readonly get: (
			kind: ModelProvidersApi.ProviderKind,
		) => Option.Option<LiveBackend>
	}
>()("@openbot-build/openbot/models/LiveBackends") {}

/** The backends, one for each provider kind. A later backend of the same kind wins. */
export const layer = (backends: ReadonlyArray<LiveBackend>) => {
	const map = HashMap.fromIterable(
		backends.map((backend) => [backend.kind, backend] as const),
	)
	return Layer.succeed(LiveBackends, {
		get: (kind) => HashMap.get(map, kind),
	})
}

export const empty = layer([])

export const find = (
	backends: Option.Option<typeof LiveBackends.Service>,
	kind: ModelProvidersApi.ProviderKind,
) => Option.flatMap(backends, (service) => service.get(kind))
