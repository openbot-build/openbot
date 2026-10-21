import { AuthApi, type Caller, Identity } from "@openbot-build/api"
import { Effect, Layer, Match, Option } from "effect"
import {
	Cookies,
	HttpEffect,
	HttpMethod,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"
import { Tokens } from "./Tokens.ts"
import { Auth } from "./Auth.js"
import { AuthUnavailable, CredentialRejected } from "./Model.ts"
import { Organization } from "../organization/Organization.ts"

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
			session: (httpEffect, { credential }) =>
				auth.resolveSession(credential).pipe(
					Effect.mapError(publicError),
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
 * Find the caller of one credential before the organization's ordinary business handlers run.
 * Browsers do not send tokens on their own, so tokens need no Origin check.
 */
export const layerAgentAuth = (config: { readonly publicOrigin: string }) =>
	Layer.effect(
		AuthApi.AgentAuth,
		Effect.gen(function* () {
			const auth = yield* Auth
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
							Effect.provideService(httpEffect, Identity, caller),
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
							.pipe(Effect.mapError(publicError))
						if (forbiddenOrigin) return yield* AuthApi.ForbiddenOrigin.make({})
						yield* setSessionCookies(session.setCookies)
						return yield* Effect.provideService(httpEffect, Identity, {
							kind: "member",
							...session.identity,
						})
					}),
			}
		}),
	)
