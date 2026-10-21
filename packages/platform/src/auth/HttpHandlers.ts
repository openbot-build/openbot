import {
	AuthApi,
	type Caller,
	Identity,
	PlatformApi,
	UserTokensApi,
} from "@openbot-build/platform-api"
import { Effect, Layer, Match, Option, Redacted } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { AuditLog } from "../audit/AuditLog.ts"
import * as Authorize from "../authorization/Authorize.ts"
import { userKey } from "../authorization/Policy.ts"
import { Tokens } from "./Tokens.ts"
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
	const userTokens = HttpApiBuilder.group(
		PlatformApi,
		"userTokens",
		(handlers) =>
			Effect.gen(function* () {
				const tokens = yield* Tokens
				const audit = yield* AuditLog
				const record = (
					caller: Caller,
					action: "token.created" | "token.revoked",
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
	return Layer.mergeAll(login, account, userTokens).pipe(
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
