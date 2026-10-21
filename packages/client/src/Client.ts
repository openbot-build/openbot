import { Context, type Schema, Effect, Layer, Option, Redacted } from "effect"
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
	HttpApiClient.make(PlatformApi, options).pipe(
		Effect.map((api) => Client.of({ api })),
	)

export const layer = (options: {
	readonly baseUrl: string
	/**
	 * A user token sent as `Authorization: Bearer` on normal operations.
	 * Leave it out in a same-origin browser client that uses the session Cookie.
	 */
	readonly token?: string | Redacted.Redacted<string>
	readonly onUnauthorized?: () => void
}): Layer.Layer<Client> => {
	const token = Option.map(Option.fromNullishOr(options.token), (token) =>
		Redacted.isRedacted(token) ? Redacted.value(token) : token,
	)
	const reportUnauthorized = (response: { readonly status: number }) =>
		Effect.sync(() => {
			if (response.status === 401) options.onUnauthorized?.()
		})
	return Layer.effect(Client, make(options)).pipe(
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
						Option.match(token, {
							onNone: () => request,
							onSome: (token) => HttpClientRequest.bearerToken(request, token),
						}),
					).pipe(Effect.tap(reportUnauthorized)),
				),
				HttpApiMiddleware.layerClient(SessionAuth, ({ request, next }) =>
					next(request).pipe(Effect.tap(reportUnauthorized)),
				),
			),
		),
	)
}
