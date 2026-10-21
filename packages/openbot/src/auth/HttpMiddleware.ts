import {
	Account,
	type AccountCaller,
	AuthApi,
	type Caller,
	Identity,
} from "@openbot-build/api"
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
 * The organization of a request with the session cookie. The
 * `OpenBot-Organization` header picks one. Without it, the only active
 * organization of the account is the answer.
 */
const chooseOrganization = (
	session: { readonly memberships: ReadonlyArray<AuthApi.Membership> },
	header: string | undefined,
) => {
	const active = session.memberships.filter(
		(membership) => membership.status === "active",
	)
	if (header !== undefined)
		return active.some((membership) => membership.organizationId === header)
			? Effect.succeed(header)
			: Effect.fail(AuthApi.MembershipRequired.make({}))
	const [only, ...rest] = active
	if (only === undefined)
		return Effect.fail(AuthApi.MembershipRequired.make({}))
	return rest.length === 0
		? Effect.succeed(only.organizationId)
		: Effect.fail(AuthApi.OrganizationRequired.make({}))
}

/** Resolve the session cookie. A write from the browser must come from the public origin. */
const resolveCookie = (
	auth: typeof Auth.Service,
	config: { readonly publicOrigin: string },
	credential: Parameters<typeof auth.resolveSession>[0],
) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		const forbiddenOrigin =
			HttpMethod.hasBody(request.method) &&
			request.headers["origin"] !== config.publicOrigin
		const session = yield* auth
			.resolveSession(credential, { refresh: !forbiddenOrigin })
			.pipe(Effect.mapError(publicError))
		if (forbiddenOrigin) return yield* AuthApi.ForbiddenOrigin.make({})
		yield* setSessionCookies(session.setCookies)
		return { request, session }
	})

/** A token stops working as soon as its member or its organization is suspended. */
const activeToken = (
	tokens: typeof Tokens.Service,
	organization: typeof Organization.Service,
	credential: Parameters<typeof tokens.authenticate>[0],
) =>
	tokens.authenticate(credential).pipe(
		Effect.flatMap((caller) =>
			organization.activeMember(caller.organizationId, caller.userId).pipe(
				Effect.mapError(() => AuthUnavailable.make({ dependency: "storage" })),
				Effect.flatMap((member) =>
					Option.isSome(member)
						? Effect.succeed(caller)
						: Effect.fail(CredentialRejected.make({ kind: "membership" })),
				),
			),
		),
		Effect.mapError(publicError),
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
			return {
				token: (httpEffect, { credential }) =>
					activeToken(tokens, organization, credential).pipe(
						Effect.flatMap((caller) =>
							Effect.provideService(httpEffect, Identity, caller),
						),
					),
				session: (httpEffect, { credential }) =>
					Effect.gen(function* () {
						const { request, session } = yield* resolveCookie(
							auth,
							config,
							credential,
						)
						const organizationId = yield* chooseOrganization(
							session,
							request.headers[AuthApi.OrganizationHeader],
						)
						const caller: Caller = {
							kind: "member",
							userId: session.userId,
							organizationId,
						}
						return yield* Effect.provideService(httpEffect, Identity, caller)
					}),
			}
		}),
	)

/** Find the account of a request that does not act in one organization. */
export const layerAccountAuth = (config: { readonly publicOrigin: string }) =>
	Layer.effect(
		AuthApi.AccountAuth,
		Effect.gen(function* () {
			const auth = yield* Auth
			const tokens = yield* Tokens
			const organization = yield* Organization
			return {
				token: (httpEffect, { credential }) =>
					activeToken(tokens, organization, credential).pipe(
						Effect.flatMap((caller) => {
							const account: AccountCaller = {
								kind: "user_token",
								userId: caller.userId,
								organizationId: caller.organizationId,
								...(caller.tokenId === undefined
									? {}
									: { tokenId: caller.tokenId }),
							}
							return Effect.provideService(httpEffect, Account, account)
						}),
					),
				session: (httpEffect, { credential }) =>
					Effect.gen(function* () {
						const { session } = yield* resolveCookie(auth, config, credential)
						const account: AccountCaller = {
							kind: "member",
							userId: session.userId,
						}
						return yield* Effect.provideService(httpEffect, Account, account)
					}),
			}
		}),
	)
