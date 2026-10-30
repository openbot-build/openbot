import * as Model from "@openbot-build/domain/Access"
import type { AuthUnavailable, CredentialRejected } from "../auth/Model.ts"
import { Auth } from "../auth/Auth.ts"
import * as Middleware from "../auth/HttpMiddleware.ts"
import { HttpServerRequest } from "effect/http"
import { Option } from "effect"
import * as Failures from "../errors/Failures.ts"
import { OpenBotApi } from "@openbot-build/api"
import { Account } from "@openbot-build/domain"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Access } from "./Access.ts"
export const layer = Layer.mergeAll(
	HttpApiBuilder.group(OpenBotApi, "access", (handlers) =>
		Effect.gen(function* () {
			const access = yield* Access
			return handlers
				.handle("users", ({ query }) =>
					access.users(query.after, query.limit ?? 50),
				)
				.handle(
					"updateUser",
					({ params, payload }) =>
						Effect.flatMap(Account, (a) =>
							access.updateUser(params.userId, payload.status, a.userId),
						),
					{ uninterruptible: true },
				)
				.handle("requests", ({ query }) =>
					access.requests(query.after, query.limit ?? 50),
				)
				.handle(
					"decide",
					({ params, payload }) =>
						Effect.flatMap(Account, (a) =>
							access.decide(
								params.requestId,
								payload.expectedVersion,
								payload.status,
								a.userId,
							),
						),
					{ uninterruptible: true },
				)
				.handle("grants", ({ query }) =>
					access.grants(query.after, query.limit ?? 50),
				)
				.handle(
					"grant",
					({ payload }) =>
						Effect.flatMap(Account, (a) =>
							access.grant(payload.email, payload.providerId, a.userId),
						),
					{ uninterruptible: true },
				)
				.handle(
					"revokeGrant",
					({ payload }) =>
						Effect.flatMap(Account, (a) =>
							access.grant(payload.email, payload.providerId, a.userId, true),
						),
					{ uninterruptible: true },
				)
				.handle("audit", ({ query }) =>
					access.audit(query.after, query.limit ?? 50),
				)
		}),
	),
	HttpApiBuilder.group(OpenBotApi, "loginOptions", (handlers) =>
		Effect.gen(function* () {
			const access = yield* Access
			return handlers.handle("get", () => access.loginOptions)
		}),
	),
	HttpApiBuilder.group(OpenBotApi, "emailSignIn", (handlers) =>
		Effect.gen(function* () {
			const auth = yield* Auth
			const address = Effect.map(HttpServerRequest.HttpServerRequest, (r) =>
				Option.getOrElse(r.remoteAddress, () => "unknown"),
			)
			const failure = <A, R>(
				effect: Effect.Effect<
					A,
					| AuthUnavailable
					| CredentialRejected
					| Model.AccessDenied
					| Model.AccessUnavailable
					| Model.AccessConflict,
					R
				>,
			) =>
				effect.pipe(
					Effect.catchTag("CredentialRejected", () =>
						Effect.fail(Model.AccessDenied.make({ reason: "identity" })),
					),
					Failures.replaceTag(
						"AuthUnavailable",
						"Email sign-in is not available.",
						() => Model.AccessUnavailable.make({}),
					),
				)
			return handlers
				.handle("send", ({ payload }) =>
					Effect.gen(function* () {
						return yield* auth
							.emailSend({ ...payload, address: yield* address })
							.pipe(failure)
					}),
				)
				.handle("verify", ({ payload }) =>
					Effect.gen(function* () {
						const result = yield* auth
							.emailVerify({ ...payload, address: yield* address })
							.pipe(failure)
						yield* Middleware.setSessionCookies(result.setCookies)
					}),
				)
		}),
	),
)
