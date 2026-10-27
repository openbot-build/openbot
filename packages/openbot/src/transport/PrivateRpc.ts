import { Context, Effect, Layer, Redacted } from "effect"
import {
	HttpClient,
	HttpClientRequest,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"
import { sameSecret } from "../secrets/Compare.ts"

/** One private RPC secret is supplied by the process entry point. */
export class Secret extends Context.Service<
	Secret,
	Redacted.Redacted<string>
>()("@openbot-build/openbot/transport/PrivateRpc/Secret") {}

/** Capture the secret once. The returned gate needs only the current request. */
export const make = Effect.map(Secret, (secret) => ({
	protect: <E, R>(
		body: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
	) =>
		Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
			sameSecret(
				request.headers["authorization"] ?? "",
				`Bearer ${Redacted.value(secret)}`,
			)
				? body
				: Effect.succeed(HttpServerResponse.empty({ status: 401 })),
		),
}))

export const layerClient = Layer.effect(
	HttpClient.HttpClient,
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient
		const secret = yield* Secret
		return HttpClient.mapRequest(client, HttpClientRequest.bearerToken(secret))
	}),
)
