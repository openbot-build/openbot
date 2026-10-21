import {
	AuthApi,
	type Caller,
	Identity,
	type OrganizationApi,
	PlatformApi,
	UserTokensApi,
} from "@openbot-build/platform-api"
import { Effect, Layer, Option } from "effect"
import { HttpEffect, HttpRouter, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { AuditLog } from "../audit/AuditLog.ts"
import * as Authorize from "../authorization/Authorize.ts"
import { userKey } from "../authorization/Policy.ts"
import { Tokens } from "./Tokens.ts"
import { Auth } from "./Auth.ts"
import * as HttpMiddleware from "./HttpMiddleware.ts"

/** Better Auth serves its own routes. Platform adds the session and user token routes. */
export const layer = (config: { readonly publicOrigin: string }) => {
	const account = HttpApiBuilder.group(PlatformApi, "account", (handlers) =>
		handlers.handle("session", () =>
			Effect.map(AuthApi.AuthSession, ({ session }) => session),
		),
	)
	const userTokens = HttpApiBuilder.group(
		PlatformApi,
		"userTokens",
		(handlers) =>
			Effect.gen(function* () {
				const tokens = yield* Tokens
				const audit = yield* AuditLog
				const record = (
					caller: Caller,
					action: OrganizationApi.AuditActionOf<"token">,
					token: UserTokensApi.Token,
				) =>
					audit
						.record({
							organizationId: caller.organizationId,
							action,
							actor: caller,
							resource: userKey({
								organizationId: caller.organizationId,
								userId: caller.userId,
							}),
							details: { tokenId: token.id, name: token.name },
						})
						.pipe(
							Effect.mapError(() =>
								UserTokensApi.TokenStorageUnavailable.make({}),
							),
						)
				return handlers
					.handle("listTokens", () =>
						Effect.flatMap(Identity, tokens.list).pipe(
							Effect.map((items) => ({ items })),
						),
					)
					.handle("createToken", ({ payload }) =>
						Effect.gen(function* () {
							const caller = yield* Identity
							const created = yield* tokens.create(caller, payload)
							yield* record(caller, "token.created", created.token)
							return created
						}),
					)
					.handle("revokeToken", ({ params }) =>
						Effect.gen(function* () {
							const caller = yield* Identity
							const revoked = yield* tokens.revoke(caller, params.tokenId)
							yield* record(caller, "token.revoked", revoked)
						}),
					)
					.handle("verifyToken", () =>
						Effect.gen(function* () {
							const caller = yield* Identity
							if (caller.tokenId === undefined) return { caller, token: null }
							const token = yield* tokens.find(caller, caller.tokenId)
							return { caller, token: Option.getOrNull(token) }
						}),
					)
			}),
	)
	return Layer.mergeAll(account, userTokens).pipe(
		Layer.provideMerge(
			Layer.merge(HttpMiddleware.layerAgentAuth(config), Authorize.layer),
		),
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
			`${AuthApi.AuthBasePath}/*` as const,
			HttpEffect.fromWebHandler(auth.handler).pipe(
				Effect.map(HttpServerResponse.setHeader("cache-control", "no-store")),
			),
		)
	}),
)
