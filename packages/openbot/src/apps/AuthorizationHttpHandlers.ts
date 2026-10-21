import {
	AppAuthorizationApi as Api,
	AuthApi,
	OpenBotApi,
} from "@openbot-build/api"
import { Effect, Layer, Option, Redacted } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Authorizations } from "./Authorizations.ts"
import { ownersOf } from "./StoredConnections.ts"
import { Auth } from "../auth/Auth.ts"
import * as HttpMiddleware from "../auth/HttpMiddleware.ts"

const escapeHtml = (value: string) =>
	value.replace(
		/[&<>"']/g,
		(character) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				character
			] ?? character,
	)

export const layer = (publicOrigin: string) =>
	Layer.merge(
		HttpApiBuilder.group(OpenBotApi, "appAuthorization", (handlers) =>
			Effect.gen(function* () {
				const authorization = yield* Authorizations
				return handlers
					.handle("beginAppAuthorization", ({ params, payload }) =>
						authorization.begin(params.connectionId, payload),
					)
					.handle("getAppAuthorization", ({ params }) =>
						authorization.get(params.flowId),
					)
					.handle("completeAppAuthorization", ({ params }) =>
						authorization.complete(params.flowId),
					)
					.handle("revokeAppAuthorization", ({ params }) =>
						authorization.revoke(params.connectionId),
					)
			}),
		),
		HttpApiBuilder.group(OpenBotApi, "appAuthorizationPublic", (handlers) =>
			Effect.gen(function* () {
				const authorization = yield* Authorizations
				const auth = yield* Auth
				return handlers
					.handle("appClientMetadata", () =>
						Effect.succeed(authorization.metadata),
					)
					.handleRaw("appAuthorizationCallback", () =>
						Effect.gen(function* () {
							const request = yield* HttpServerRequest.HttpServerRequest
							const cookie = request.cookies[AuthApi.SessionCookie]
							const owner =
								cookie === undefined
									? Option.none<ReadonlyArray<string>>()
									: yield* auth.resolveSession(Redacted.make(cookie)).pipe(
											Effect.tap(({ setCookies }) =>
												HttpMiddleware.setSessionCookies(setCookies),
											),
											Effect.map((session) => Option.some(ownersOf(session))),
											// A rejected cookie means the caller must log in first.
											Effect.catchTag(
												"CredentialRejected",
												() => Effect.succeedNone,
											),
											Effect.mapError(() =>
												Api.AppAuthorizationUnavailable.make({}),
											),
										)
							return yield* authorization.receive(request.url, owner).pipe(
								Effect.map((receipt) => {
									const target = new URL(
										receipt.requiresLogin ? "/" : receipt.returnTo,
										publicOrigin,
									)
									target.searchParams.set("authorization", receipt.flowId)
									// Without a session, the client signs in with Better Auth and then reads the flow.
									return HttpServerResponse.empty({
										status: 303,
										headers: {
											location: target.href,
											"cache-control": "no-store",
											"referrer-policy": "no-referrer",
										},
									})
								}),
								Effect.catchTag("AppAuthorizationFailed", (error) =>
									request.headers["accept"]?.includes("text/html") === true
										? Effect.succeed(
												HttpServerResponse.text(
													`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>App authorization</title><style>*{box-sizing:border-box}html{font:100%/1.5 system-ui;color-scheme:light dark}body{margin:0;padding:clamp(1rem,4vw,3rem);overflow-wrap:anywhere}main{max-width:40rem;margin-inline:auto}h1{font-size:clamp(1.5rem,5vw,2rem);line-height:1.25}form{max-width:32rem}button{font:inherit;max-width:100%;padding:.5rem .75rem;margin:.25rem 0}</style><main><h1>App authorization could not complete</h1><p>${escapeHtml(error.message)}</p></main></html>`,
													{
														status: 422,
														contentType: "text/html",
														headers: {
															"cache-control": "no-store",
															"referrer-policy": "no-referrer",
														},
													},
												),
											)
										: Effect.fail(error),
								),
							)
						}),
					)
			}),
		).pipe(Layer.provide(HttpMiddleware.layerNoStore)),
	)
