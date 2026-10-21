import { AuthApi, PlatformApi } from "@openbot-build/platform-api"
import { Effect, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { ApiKeys } from "./ApiKeys.ts"
import { Auth } from "./Auth.ts"
import * as HttpMiddleware from "./HttpMiddleware.ts"

/** Better Auth serves its own routes. Platform adds the session and API key routes. */
export const layer = (config: { readonly publicOrigin: string }) => {
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

/**
 * Mounts the Better Auth handler, as the Better Auth Effect guide shows.
 * Routes in the Platform contract, such as `/auth/session`, are exact paths, so they win over this wildcard.
 * Sign-in responses carry cookies, so no cache may keep them.
 */
export const layerBetterAuth = Layer.unwrap(
	Effect.gen(function* () {
		const auth = yield* Auth
		return HttpRouter.add(
			"*",
			AuthApi.AuthBasePath + "/*",
			HttpEffect.fromWebHandler(auth.handler).pipe(
				Effect.map(HttpServerResponse.setHeader("cache-control", "no-store")),
			),
		)
	}),
)
