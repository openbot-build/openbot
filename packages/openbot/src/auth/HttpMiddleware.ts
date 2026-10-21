import { AuthApi, type Caller, Identity } from "@openbot-build/api"
import { Effect, Layer, Match, Option, Redacted } from "effect"
import {
	Cookies,
	HttpEffect,
	HttpMethod,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"
import { Tokens } from "./Tokens.ts"
import {
	ExecutionFence,
	RequestEpoch,
	CurrentSessionOwner,
} from "../execution/ExecutionFence.ts"
import { Auth } from "./Auth.js"
import { AuthUnavailable, CredentialRejected } from "./Model.ts"
import { Organization } from "../organization/Organization.ts"

// A read may lazily create its Main Agent. Keep the request epoch for that write too.
const requestEpoch = (accountId: string, header: string | undefined) =>
	header === undefined
		? undefined
		: {
				accountId,
				epoch: /^[0-9]+$/.test(header) ? Number(header) : Number.NaN,
			}

/** The public error for a credential that failed to resolve. */
const publicError = (error: AuthUnavailable | CredentialRejected) =>
	Match.value(error).pipe(
		Match.tagsExhaustive({
			AuthUnavailable: () => AuthApi.AuthenticationUnavailable.make({}),
			CredentialRejected: ({ kind }) =>
				kind === "membership"
					? AuthApi.MembershipRequired.make({})
					: AuthApi.AuthenticationRequired.make({}),
		}),
	)

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
			session: (httpEffect) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest
					const credential = Redacted.make(
						request.cookies[auth.sessionCookie ?? AuthApi.SessionCookie] ?? "",
					)
					const refresh =
						new URL(request.url, "https://request.invalid").searchParams.get(
							"refresh",
						) !== "false"
					const { setCookies, ...session } = yield* auth
						.resolveSession(credential, { refresh })
						.pipe(Effect.mapError(publicError))
					yield* setSessionCookies(setCookies)
					return yield* Effect.provideService(httpEffect, AuthApi.AuthSession, {
						session,
						credential,
					})
				}),
		}
	}),
)

/**
 * Find the caller of one credential before the organization's ordinary business handlers run.
 * Browsers do not send tokens on their own, so tokens need no Origin check.
 */
export const layerAgentAuth = (config: { readonly publicOrigin: string }) =>
	Layer.effect(
		AuthApi.AgentAuth,
		Effect.gen(function* () {
			const auth = yield* Auth
			const fence = yield* Effect.serviceOption(ExecutionFence)
			const tokens = yield* Tokens
			const organization = yield* Organization
			/** A token stops working as soon as its member is suspended or removed. */
			const activeMember = (caller: Caller) =>
				organization.member(caller.organizationId, caller.userId).pipe(
					Effect.mapError(() =>
						AuthUnavailable.make({ dependency: "storage" }),
					),
					Effect.flatMap((member) =>
						Option.exists(member, (member) => member.status === "active")
							? Effect.succeed(caller)
							: Effect.fail(CredentialRejected.make({ kind: "membership" })),
					),
				)
			return {
				token: (httpEffect, { credential }) =>
					tokens.authenticate(credential).pipe(
						Effect.flatMap(activeMember),
						Effect.mapError(publicError),
						Effect.flatMap((caller) =>
							Effect.gen(function* () {
								const request = yield* HttpServerRequest.HttpServerRequest
								const operation = Effect.provideService(
									httpEffect,
									Identity,
									caller,
								).pipe(
									Effect.provideService(CurrentSessionOwner, {
										namespace: JSON.stringify([
											caller.organizationId,
											caller.userId,
										]),
										accountId: caller.userId,
									}),
									Effect.provideService(
										RequestEpoch,
										requestEpoch(caller.userId, request.headers["x-kay-epoch"]),
									),
								)
								return yield* HttpMethod.hasBody(request.method) &&
								Option.isSome(fence)
									? fence.value.admit(caller.userId, operation).pipe(
											Effect.provideService(
												RequestEpoch,
												request.headers["x-kay-epoch"] === undefined
													? undefined
													: {
															accountId: caller.userId,
															epoch: /^[0-9]+$/.test(
																request.headers["x-kay-epoch"],
															)
																? Number(request.headers["x-kay-epoch"])
																: Number.NaN,
														},
											),
											Effect.catchTag("FenceUnavailable", () =>
												AuthApi.AuthenticationUnavailable.make({}),
											),
										)
									: operation
							}),
						),
					),
				session: (httpEffect) =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest
						const credential = Redacted.make(
							request.cookies[auth.sessionCookie ?? AuthApi.SessionCookie] ??
								"",
						)
						const forbiddenOrigin =
							HttpMethod.hasBody(request.method) &&
							request.headers["origin"] !== config.publicOrigin
						const session = yield* auth
							.resolveSession(credential, {
								refresh: !forbiddenOrigin,
							})
							.pipe(Effect.mapError(publicError))
						if (forbiddenOrigin) return yield* AuthApi.ForbiddenOrigin.make({})
						yield* setSessionCookies(session.setCookies)
						const operation = Effect.provideService(httpEffect, Identity, {
							kind: "member",
							...session.identity,
						}).pipe(
							Effect.provideService(CurrentSessionOwner, {
								namespace: JSON.stringify([
									session.identity.organizationId,
									session.identity.userId,
								]),
								accountId: session.identity.userId,
							}),
							Effect.provideService(
								RequestEpoch,
								requestEpoch(
									session.identity.userId,
									request.headers["x-kay-epoch"],
								),
							),
						)
						return yield* HttpMethod.hasBody(request.method) &&
						Option.isSome(fence)
							? fence.value.admit(session.identity.userId, operation).pipe(
									Effect.provideService(
										RequestEpoch,
										request.headers["x-kay-epoch"] === undefined
											? undefined
											: {
													accountId: session.identity.userId,
													epoch: /^[0-9]+$/.test(request.headers["x-kay-epoch"])
														? Number(request.headers["x-kay-epoch"])
														: Number.NaN,
												},
									),
									Effect.catchTag("FenceUnavailable", () =>
										AuthApi.AuthenticationUnavailable.make({}),
									),
								)
							: operation
					}),
			}
		}),
	)
