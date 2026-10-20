import { AuthApi, Identity } from "@openbot-build/platform-api"
import { Effect, Layer, Match } from "effect"
import {
	Cookies,
	HttpEffect,
	HttpMethod,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"
import { ApiKeys } from "./ApiKeys.ts"
import { Auth } from "./Auth.js"

export const setSessionCookies = (setCookies: ReadonlyArray<string>) =>
	HttpEffect.appendPreResponseHandler((_, response) =>
		Effect.succeed(
			HttpServerResponse.mergeCookies(
				response,
				Cookies.fromSetCookie(setCookies),
			),
		),
	)

export const layerOrigin = (config: { readonly publicOrigin: string }) =>
	Layer.succeed(AuthApi.OriginCheck, (httpEffect) =>
		Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest
			if (request.headers["origin"] !== config.publicOrigin)
				return yield* AuthApi.ForbiddenOrigin.make({})
			return yield* httpEffect
		}),
	)

export const layerNoStore = Layer.succeed(AuthApi.NoStore, (httpEffect) =>
	httpEffect.pipe(
		HttpEffect.withPreResponseHandler((_, response) =>
			Effect.succeed(
				HttpServerResponse.setHeader(response, "cache-control", "no-store"),
			),
		),
	),
)

export const layerSessionAuth = Layer.effect(
	AuthApi.SessionAuth,
	Effect.gen(function* () {
		const auth = yield* Auth
		return {
			session: (httpEffect, { credential }) =>
				auth.resolveSession(credential).pipe(
					Effect.mapError((error) =>
						Match.value(error).pipe(
							Match.tagsExhaustive({
								AuthUnavailable: () =>
									AuthApi.AuthenticationUnavailable.make({}),
								CredentialRejected: () =>
									AuthApi.AuthenticationRequired.make({}),
							}),
						),
					),
					Effect.flatMap(({ setCookies, ...session }) =>
						Effect.andThen(
							setSessionCookies(setCookies),
							Effect.provideService(httpEffect, AuthApi.AuthSession, {
								session,
								credential,
							}),
						),
					),
				),
		}
	}),
)

/**
 * Find the owner of one credential before the tenant's ordinary business handlers run.
 * Browsers do not send API keys on their own, so API keys need no Origin check.
 */
export const layerAgentAuth = (config: { readonly publicOrigin: string }) =>
	Layer.effect(
		AuthApi.AgentAuth,
		Effect.gen(function* () {
			const auth = yield* Auth
			const apiKeys = yield* ApiKeys
			return {
				apiKey: (httpEffect, { credential }) =>
					apiKeys.authenticate(credential).pipe(
						Effect.mapError((error) =>
							Match.value(error).pipe(
								Match.tagsExhaustive({
									AuthUnavailable: () =>
										AuthApi.AuthenticationUnavailable.make({}),
									CredentialRejected: () =>
										AuthApi.AuthenticationRequired.make({}),
								}),
							),
						),
						Effect.flatMap((identity) =>
							Effect.provideService(httpEffect, Identity, identity),
						),
					),
				session: (httpEffect, { credential }) =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest
						const forbiddenOrigin =
							HttpMethod.hasBody(request.method) &&
							request.headers["origin"] !== config.publicOrigin
						const session = yield* auth
							.resolveSession(credential, {
								refresh: !forbiddenOrigin,
							})
							.pipe(
								Effect.mapError((error) =>
									Match.value(error).pipe(
										Match.tagsExhaustive({
											AuthUnavailable: () =>
												AuthApi.AuthenticationUnavailable.make({}),
											CredentialRejected: () =>
												AuthApi.AuthenticationRequired.make({}),
										}),
									),
								),
							)
						if (forbiddenOrigin) return yield* AuthApi.ForbiddenOrigin.make({})
						yield* setSessionCookies(session.setCookies)
						return yield* Effect.provideService(
							httpEffect,
							Identity,
							session.identity,
						)
					}),
			}
		}),
	)
