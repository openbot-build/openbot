import { AuthApi, PlatformApi } from "@openbot-build/platform-api"
import { Effect, Layer, Match, Redacted } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { ApiKeys } from "./ApiKeys.ts"
import { Auth } from "./Auth.ts"
import * as HttpMiddleware from "./HttpMiddleware.ts"

/** Better Auth owns protocol responses and cookies. Handlers map them to public Platform shapes. */
export const layer = (config: { readonly publicOrigin: string }) => {
	const login = HttpApiBuilder.group(PlatformApi, "login", (handlers) =>
		Effect.gen(function* () {
			const auth = yield* Auth
			return handlers
				.handleRaw("login", ({ query }) =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest
						return HttpServerResponse.fromWeb(
							yield* auth.startLogin(
								new Headers(request.headers),
								query.returnTo,
							),
						)
					}).pipe(
						Effect.mapError((error) =>
							Match.value(error).pipe(
								Match.tagsExhaustive({
									AuthRequestInvalid: () =>
										AuthApi.InvalidAccountRequest.make({}),
									AuthUnavailable: () =>
										AuthApi.AuthenticationUnavailable.make({}),
								}),
							),
						),
					),
				)
				.handleRaw("callback", () =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest
						return HttpServerResponse.fromWeb(
							yield* auth.completeLogin(
								request.url,
								new Headers(request.headers),
							),
						)
					}).pipe(
						Effect.mapError(() => AuthApi.AuthenticationUnavailable.make({})),
					),
				)
				.handleRaw("logout", () =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest
						return HttpServerResponse.fromWeb(
							yield* auth.logout(
								Redacted.make(request.cookies[AuthApi.SessionCookie] ?? ""),
							),
						)
					}).pipe(
						Effect.mapError(() => AuthApi.AuthenticationUnavailable.make({})),
					),
				)
		}),
	)
	const account = HttpApiBuilder.group(PlatformApi, "account", (handlers) =>
		handlers.handle("session", () =>
			Effect.map(AuthApi.AuthSession, ({ session }) => session),
		),
	)
	const apiKeys = HttpApiBuilder.group(PlatformApi, "apiKeys", (handlers) =>
		Effect.gen(function* () {
			const keys = yield* ApiKeys
			const owner = Effect.map(
				AuthApi.AuthSession,
				({ session }) => session.identity,
			)
			return handlers
				.handle("listApiKeys", () =>
					Effect.flatMap(owner, keys.list).pipe(
						Effect.map((keys) => ({ keys })),
					),
				)
				.handle("createApiKey", ({ payload }) =>
					Effect.flatMap(owner, (identity) => keys.create(identity, payload)),
				)
				.handle("revokeApiKey", ({ params }) =>
					Effect.flatMap(owner, (identity) =>
						keys.revoke(identity, params.keyId),
					),
				)
		}),
	)
	return Layer.mergeAll(
		login,
		account,
		apiKeys,
		HttpMiddleware.layerAgentAuth(config),
	).pipe(
		Layer.provide([
			HttpMiddleware.layerSessionAuth,
			HttpMiddleware.layerOrigin(config),
			HttpMiddleware.layerNoStore,
		]),
	)
}
