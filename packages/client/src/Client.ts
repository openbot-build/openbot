import { Context, type Schema, Effect, Layer, Redacted } from "effect"
import {
	HttpApiClient,
	type HttpApiEndpoint,
	type HttpApiGroup,
	HttpApiMiddleware,
} from "effect/http-api"
import {
	PlatformApi,
	AgentAuth,
	SessionAuth,
} from "@openbot-build/platform-api"
import {
	type HttpClientError,
	FetchHttpClient,
	type HttpClient,
	HttpClientRequest,
} from "effect/http"

export class Client extends Context.Service<
	Client,
	{
		readonly api: HttpApiClient.ForApi<typeof PlatformApi>
	}
>()("@openbot-build/client/Client") {}

export type ClientError =
	| HttpApiEndpoint.Errors<
			HttpApiGroup.Endpoints<
				(typeof PlatformApi.groups)[keyof typeof PlatformApi.groups]
			>
	  >
	| Schema.SchemaError
	| HttpClientError.HttpClientError

export const make = (options: {
	readonly baseUrl: string
}): Effect.Effect<
	typeof Client.Service,
	never,
	| HttpClient.HttpClient
	| HttpApiMiddleware.ForClient<AgentAuth>
	| HttpApiMiddleware.ForClient<SessionAuth>
> =>
	Effect.gen(function* () {
		const api = yield* HttpApiClient.make(PlatformApi, options)
		return Client.of({ api })
	})

export const layer = (options: {
	readonly baseUrl: string
	/**
	 * An API key sent as `Authorization: Bearer` on normal operations.
	 * Leave it out in a same-origin browser client that uses the session Cookie.
	 */
	readonly apiKey?: string | Redacted.Redacted<string>
	readonly onUnauthorized?: () => void
}): Layer.Layer<Client> =>
	Layer.effect(Client, make(options)).pipe(
		Layer.provide(
			Layer.mergeAll(
				FetchHttpClient.layer.pipe(
					Layer.provide(
						Layer.succeed(FetchHttpClient.RequestInit, {
							credentials: "same-origin",
						}),
					),
				),
				HttpApiMiddleware.layerClient(AgentAuth, ({ request, next }) =>
					next(
						options.apiKey === undefined
							? request
							: HttpClientRequest.bearerToken(
									request,
									Redacted.isRedacted(options.apiKey)
										? Redacted.value(options.apiKey)
										: options.apiKey,
								),
					).pipe(
						Effect.tap((response) =>
							Effect.sync(() => {
								if (response.status === 401) options.onUnauthorized?.()
							}),
						),
					),
				),
				HttpApiMiddleware.layerClient(SessionAuth, ({ request, next }) =>
					next(request).pipe(
						Effect.tap((response) =>
							Effect.sync(() => {
								if (response.status === 401) options.onUnauthorized?.()
							}),
						),
					),
				),
			),
		),
	)
