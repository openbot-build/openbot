import * as HttpErrors from "../execution/HttpErrors.ts"
import { AppAuthorizationApi as Api, OpenBotApi } from "@openbot-build/api"

import { Effect, Layer, Option, String as Str, pipe } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Authorizations } from "./Authorizations.ts"
import { ownersOf } from "./StoredConnections.ts"
import { Auth } from "../auth/Auth.ts"
import * as HttpMiddleware from "../auth/HttpMiddleware.ts"
import * as Platform from "../settings/Platform.ts"
import { Settings } from "../settings/Settings.ts"

// The "&" goes first, so the later steps do not change the "&" that they add.
const escapeHtml = (value: string) =>
	pipe(
		value,
		Str.replaceAll("&", "&amp;"),
		Str.replaceAll("<", "&lt;"),
		Str.replaceAll(">", "&gt;"),
		Str.replaceAll('"', "&quot;"),
		Str.replaceAll("'", "&#39;"),
	)

export const layer = Layer.merge(
	HttpApiBuilder.group(OpenBotApi, "appAuthorization", (handlers) =>
		Effect.gen(function* () {
			const authorization = yield* Authorizations
			const safe = yield* HttpErrors.make
			return handlers
				.handle("beginAppAuthorization", ({ params, payload }) =>
					authorization.begin(params.connectionId, payload).pipe(safe),
				)
				.handle("getAppAuthorization", ({ params }) =>
					authorization.get(params.flowId).pipe(safe),
				)
				.handle("completeAppAuthorization", ({ params, payload }) =>
					authorization.complete(params.flowId, payload.commandKey).pipe(safe),
				)
				.handle("getAppAuthorizationAction", ({ params }) =>
					authorization.action(params.executionId).pipe(safe),
				)
				.handle("revokeAppAuthorization", ({ params, payload }) =>
					authorization
						.revoke(params.connectionId, payload.commandKey)
						.pipe(safe),
				)
		}),
	),
	HttpApiBuilder.group(OpenBotApi, "appAuthorizationPublic", (handlers) =>
		Effect.gen(function* () {
			const authorization = yield* Authorizations
			const safe = yield* HttpErrors.make
			const auth = yield* Auth
			const settings = yield* Settings
			return handlers
				.handle("appClientMetadata", () => authorization.metadata)
				.handleRaw("appAuthorizationCallback", () =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest
						const publicOrigin = yield* Platform.publicOriginOr(settings, () =>
							Api.AppAuthorizationUnavailable.make({}),
						)
						const owner = yield* HttpMiddleware.optionalSession(auth).pipe(
							Effect.map(Option.map(ownersOf)),
							// The Auth service logs the cause of each failure.
							Effect.catchTag("AuthUnavailable", () =>
								Effect.fail(Api.AppAuthorizationUnavailable.make({})),
							),
						)
						return yield* authorization.receive(request.url, owner).pipe(
							safe,
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
								Option.exists(
									Option.fromNullishOr(request.headers["accept"]),
									Str.includes("text/html"),
								)
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
