import {
	AuthApi,
	type Caller,
	Identity,
	type OrganizationApi,
	OpenBotApi,
	UserTokensApi,
} from "@openbot-build/api"
import { Effect, Layer, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import * as Failures from "../app/Failures.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { userKey } from "../audit/Resources.ts"
import * as AuthorizationLayer from "../authorization/Layer.ts"
import { Tokens } from "./Tokens.ts"
import { Auth } from "./Auth.ts"
import * as HttpMiddleware from "./HttpMiddleware.ts"

const account = HttpApiBuilder.group(OpenBotApi, "account", (handlers) =>
	handlers.handle("session", () =>
		Effect.map(AuthApi.AuthSession, ({ session }) => session),
	),
)
const userTokens = HttpApiBuilder.group(OpenBotApi, "userTokens", (handlers) =>
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
					Failures.replace("OpenBot could not write the audit log", () =>
						UserTokensApi.TokenStorageUnavailable.make({}),
					),
				)
		// Write handlers do not stop when the client goes away, so a change
		// always gets its audit entry.
		return handlers
			.handle("listTokens", () =>
				Effect.flatMap(Identity, tokens.list).pipe(
					Effect.map((items) => ({ items })),
				),
			)
			.handle(
				"createToken",
				({ payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const created = yield* tokens.create(caller, payload)
						yield* record(caller, "token.created", created.token)
						return created
					}),
				{ uninterruptible: true },
			)
			.handle(
				"revokeToken",
				({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const revoked = yield* tokens.revoke(caller, params.tokenId)
						yield* record(caller, "token.revoked", revoked)
					}),
				{ uninterruptible: true },
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
const signIn = HttpApiBuilder.group(OpenBotApi, "signIn", (handlers) =>
	Effect.gen(function* () {
		const auth = yield* Auth
		return handlers.handle("signIn", ({ payload }) =>
			Effect.gen(function* () {
				const providerId = yield* auth.signInProvider(payload.email)
				if (Option.isNone(providerId))
					return yield* AuthApi.SignInUnavailable.make({})
				const started = yield* auth.startSignIn({
					providerId: providerId.value,
					returnTo: payload.returnTo,
				})
				yield* HttpMiddleware.setSessionCookies(started.setCookies)
				return { url: started.url }
			}).pipe(
				// The Auth service logs the cause of each failure.
				Effect.catchTag("AuthUnavailable", () =>
					Effect.fail(AuthApi.AuthenticationUnavailable.make({})),
				),
			),
		)
	}),
)
/** Better Auth serves its own routes. OpenBot adds the session and user token routes. */
export const layer = Layer.mergeAll(account, userTokens, signIn).pipe(
	Layer.provideMerge(
		Layer.mergeAll(
			HttpMiddleware.layerBotAuth,
			HttpMiddleware.layerAccountAuth,
			AuthorizationLayer.layer,
			HttpMiddleware.layerSessionAuth,
			HttpMiddleware.layerOrigin,
			HttpMiddleware.layerNoStore,
		),
	),
)

/**
 * Mounts the Better Auth handler, as the Better Auth Effect guide shows.
 * Routes in the OpenBot contract, such as `/auth/session`, are exact paths, so they win over this wildcard.
 * Sign-in responses carry cookies, so no cache may keep them.
 */
export const layerBetterAuth = Layer.unwrap(
	Effect.gen(function* () {
		const auth = yield* Auth
		return HttpRouter.add(
			"*",
			`${AuthApi.AuthBasePath}/*` as const,
			Effect.scoped(
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest
					const controller = yield* Effect.acquireRelease(
						Effect.sync(() => new AbortController()),
						(controller) => Effect.sync(() => controller.abort()),
					)
					const web = yield* HttpServerRequest.toWeb(request, {
						signal: controller.signal,
					})
					return HttpServerResponse.fromWeb(yield* auth.handle(web))
				}),
			).pipe(
				Effect.map(HttpServerResponse.setHeader("cache-control", "no-store")),
			),
		)
	}),
)
