import {
	setSessionCookies,
	layerNoStore,
} from "@openbot-build/identity-contract/auth/SessionHttp"
import type { AuditActionOf } from "@openbot-build/domain/Organizations"
import {
	type Token,
	TokenStorageUnavailable,
} from "@openbot-build/domain/Tokens"
import { type Caller, Identity } from "@openbot-build/domain/Identity"
import { AuthApi, OpenBotApi } from "@openbot-build/api"

import { Effect, Layer, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import * as Failures from "@openbot-build/server-kernel/Failures"
import { AuditLog } from "@openbot-build/identity-contract/audit/AuditLog"
import { userKey } from "@openbot-build/domain/AuditResources"
import { Tokens } from "@openbot-build/identity-contract/auth/Tokens"
import { Auth } from "@openbot-build/identity-contract/auth/Auth"
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
			action: AuditActionOf<"token">,
			token: Token,
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
						TokenStorageUnavailable.make({}),
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
					invitation: payload.invitation,
					returnTo: payload.returnTo,
				})
				yield* setSessionCookies(started.setCookies)
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
/** The middleware of the protected groups. */
export const layerMiddleware = Layer.mergeAll(
	HttpMiddleware.layerBotAuth,
	HttpMiddleware.layerAccountAuth,
	HttpMiddleware.layerSessionAuth,
	HttpMiddleware.layerOrigin,
	layerNoStore,
)

/** The session, user token and sign-in groups. Better Auth serves its own routes. */
export const layerGroups = Layer.mergeAll(account, userTokens, signIn)

/** The groups of `layerGroups` together with `layerMiddleware`, for callers that build their own API. */
export const layer = layerGroups.pipe(Layer.provideMerge(layerMiddleware))

/**
 * Mounts the Better Auth handler, as the Better Auth Effect guide shows.
 * Routes in the OpenBot contract, such as `/auth/session`, always win over this wildcard.
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
