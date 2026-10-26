import {
	Account,
	type AccountCaller,
	AuthApi,
	type Caller,
	Identity,
} from "@openbot-build/api"
import {
	Array as Arr,
	Effect,
	Layer,
	Match,
	Option,
	Redacted,
	String as Str,
} from "effect"
import {
	Cookies,
	HttpEffect,
	HttpMethod,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"
import { Tokens } from "./Tokens.ts"
import { Auth } from "./Auth.ts"
import { AuthUnavailable, CredentialRejected } from "./Model.ts"
import * as Failures from "../app/Failures.ts"
import { Organization } from "../organization/Organization.ts"
import { RateLimiter } from "../billing/RateLimit.ts"
import * as Platform from "../settings/Platform.ts"
import { Settings } from "../settings/Settings.ts"

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

/**
 * The session of the session cookie, if the request has one. A rejected cookie
 * counts as no cookie, so the caller must log in first.
 */
export const optionalSession = (auth: typeof Auth.Service) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		return yield* Effect.transposeOption(
			Option.map(
				Option.fromNullishOr(request.cookies[AuthApi.SessionCookie]),
				(cookie) =>
					auth
						.resolveSession(Redacted.make(cookie))
						.pipe(
							Effect.tap(({ setCookies }) => setSessionCookies(setCookies)),
						),
			),
		).pipe(Effect.catchTag("CredentialRejected", () => Effect.succeedNone))
	})

/** A request must come from the current public origin of the platform. */
export const layerOrigin = Layer.effect(
	AuthApi.OriginCheck,
	Effect.gen(function* () {
		const settings = yield* Settings
		return (httpEffect) =>
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest
				// The contract gives this check no error for unreadable settings.
				const publicOrigin = yield* Platform.publicOriginInRequest(settings)
				if (request.headers["origin"] !== publicOrigin)
					return yield* AuthApi.ForbiddenOrigin.make({})
				return yield* httpEffect
			})
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
 * `OpenBot-Organization` header, or the `organization` query of a WebSocket,
 * picks one. Without them, the only active organization of the account is the
 * answer.
 */
const chooseOrganization = (
	session: { readonly memberships: ReadonlyArray<AuthApi.Membership> },
	named: Option.Option<string>,
) => {
	const active = Arr.filter(
		session.memberships,
		(membership) => membership.status === "active",
	)
	return Option.match(named, {
		onSome: (organizationId) =>
			Arr.some(
				active,
				(membership) => membership.organizationId === organizationId,
			)
				? Effect.succeed(organizationId)
				: Effect.fail(AuthApi.MembershipRequired.make({})),
		onNone: () =>
			Arr.match(active, {
				onEmpty: () => Effect.fail(AuthApi.MembershipRequired.make({})),
				onNonEmpty: (all) =>
					all.length === 1
						? Effect.succeed(all[0].organizationId)
						: Effect.fail(AuthApi.OrganizationRequired.make({})),
			}),
	})
}

const isWebSocket = (request: HttpServerRequest.HttpServerRequest) =>
	Option.exists(
		Option.fromNullishOr(request.headers["upgrade"]),
		(upgrade) => Str.toLowerCase(upgrade) === "websocket",
	)

/**
 * A browser cannot send headers with a WebSocket. So a WebSocket may name its
 * organization in the `organization` query field. Other requests use the header.
 */
const organizationQuery = (
	request: HttpServerRequest.HttpServerRequest,
): Option.Option<string> =>
	isWebSocket(request)
		? Option.flatMap(HttpServerRequest.toURL(request), (url) =>
				Option.fromNullOr(url.searchParams.get("organization")),
			)
		: Option.none()

/**
 * Resolve the session cookie. A write from the browser must come from the public origin.
 * So must a WebSocket, because a page on another site can open one with the cookie.
 */
const resolveCookie = (
	auth: typeof Auth.Service,
	settings: typeof Settings.Service,
	credential: Parameters<typeof auth.resolveSession>[0],
) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		const publicOrigin = yield* Platform.publicOriginOr(settings, () =>
			AuthApi.AuthenticationUnavailable.make({}),
		)
		const forbiddenOrigin =
			(HttpMethod.hasBody(request.method) || isWebSocket(request)) &&
			request.headers["origin"] !== publicOrigin
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
				Failures.replace(
					"OpenBot could not read the membership of a token",
					() => AuthUnavailable.make({ dependency: "storage" }),
				),
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
export const layerBotAuth = Layer.effect(
	AuthApi.BotAuth,
	Effect.gen(function* () {
		const auth = yield* Auth
		const settings = yield* Settings
		const tokens = yield* Tokens
		const organization = yield* Organization
		const limiter = yield* RateLimiter
		return {
			token: (httpEffect, { credential }) =>
				activeToken(tokens, organization, credential).pipe(
					Effect.tap(limiter.hit),
					Effect.flatMap((caller) =>
						Effect.provideService(httpEffect, Identity, caller),
					),
				),
			session: (httpEffect, { credential }) =>
				Effect.gen(function* () {
					const { request, session } = yield* resolveCookie(
						auth,
						settings,
						credential,
					)
					const organizationId = yield* chooseOrganization(
						session,
						Option.orElse(
							Option.fromUndefinedOr(
								request.headers[AuthApi.OrganizationHeader],
							),
							() => organizationQuery(request),
						),
					)
					const caller: Caller = {
						kind: "member",
						userId: session.userId,
						organizationId,
					}
					yield* limiter.hit(caller)
					return yield* Effect.provideService(httpEffect, Identity, caller)
				}),
		}
	}),
)

/** Find the account of a request that does not act in one organization. */
export const layerAccountAuth = Layer.effect(
	AuthApi.AccountAuth,
	Effect.gen(function* () {
		const auth = yield* Auth
		const settings = yield* Settings
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
					const { session } = yield* resolveCookie(auth, settings, credential)
					const account: AccountCaller = {
						kind: "member",
						userId: session.userId,
					}
					return yield* Effect.provideService(httpEffect, Account, account)
				}),
		}
	}),
)
