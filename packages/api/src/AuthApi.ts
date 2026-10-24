import { Context, Redacted, Schema } from "effect"
import {
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiMiddleware,
	HttpApiSchema,
	HttpApiSecurity,
} from "effect/http-api"
import { Account, Identity } from "./Identity.ts"
import { RoleId } from "./Roles.ts"

export const SessionCookie = "__Host-openbot-session"
/** Better Auth keeps the sign-in state in this cookie during an OpenID Connect round trip. */
export const LoginCookie = "__Host-openbot-login"
/** Better Auth serves every route under this path. */
export const AuthBasePath = "/auth"
/**
 * A same-origin path to return to after a browser sign-in or authorization round trip.
 * OpenBot serves no pages. A client on the same origin owns these paths.
 */
export const ReturnTo = Schema.String.check(
	Schema.isMaxLength(4096),
	Schema.makeFilter((value) => {
		if (
			!value.startsWith("/") ||
			value.startsWith("//") ||
			/[\\\r\n]/.test(value)
		)
			return false
		const url = URL.parse(value, "https://return.invalid")
		return (
			url !== null &&
			url.origin === "https://return.invalid" &&
			!/^\/(?:auth|v1|development)(?:\/|$)/.test(url.pathname)
		)
	}),
)
export class AuthenticationRequired extends Schema.TaggedError<AuthenticationRequired>()(
	"AuthenticationRequired",
	{},
) {}
export class AuthenticationUnavailable extends Schema.TaggedError<AuthenticationUnavailable>()(
	"AuthenticationUnavailable",
	{},
) {}
export class ForbiddenOrigin extends Schema.TaggedError<ForbiddenOrigin>()(
	"ForbiddenOrigin",
	{},
) {}
/** The account signed in, but it is not an active member of the organization. */
export class MembershipRequired extends Schema.TaggedError<MembershipRequired>()(
	"MembershipRequired",
	{},
) {}
/**
 * A request with the session cookie must say which organization it acts in,
 * because the account is a member of more than one.
 */
export class OrganizationRequired extends Schema.TaggedError<OrganizationRequired>()(
	"OrganizationRequired",
	{},
) {}
/** The caller sent more requests in this minute than the platform allows. */
export class RateLimited extends Schema.TaggedError<RateLimited>()(
	"RateLimited",
	{
		/** Wait this many seconds before the next request. */
		retryAfterSeconds: Schema.Int,
	},
) {}
/** The organization that a request with the session cookie acts in. Tokens belong to one organization, so they ignore it. */
export const OrganizationHeader = "openbot-organization"
export const AuthErrors = [
	AuthenticationRequired.pipe(HttpApiSchema.status(401)),
	MembershipRequired.pipe(HttpApiSchema.status(403)),
	AuthenticationUnavailable.pipe(HttpApiSchema.status(503)),
] as const
/** One organization of the signed-in account. */
export const Membership = Schema.Struct({
	organizationId: Schema.String,
	name: Schema.String,
	status: Schema.Literals(["active", "suspended"]),
	roles: Schema.Array(RoleId),
})
export type Membership = typeof Membership.Type
export const SessionInfo = Schema.Struct({
	userId: Schema.String,
	profile: Schema.Struct({
		name: Schema.optionalKey(Schema.String),
		email: Schema.optionalKey(Schema.String),
		emailVerified: Schema.optionalKey(Schema.Boolean),
	}),
	/** The organizations of the account. Send one ID in the `OpenBot-Organization` header. */
	memberships: Schema.Array(Membership),
	/** A platform admin can use `/v1/platform`. */
	platformAdmin: Schema.Boolean,
	expiresAt: Schema.String,
})
export class AuthSession extends Context.Service<
	AuthSession,
	{
		readonly session: typeof SessionInfo.Type
		readonly credential: Redacted.Redacted<string>
	}
>()("@openbot-build/api/AuthApi/AuthSession") {}
/**
 * Finds the caller of ordinary business operations from a user token (`Authorization: Bearer`).
 * Same-origin browser clients can use the signed-in session Cookie instead.
 * Both schemes read their credential from the current request.
 * @effect-expect-leaking HttpServerRequest | ParsedSearchParams | RouteContext
 */
export class BotAuth extends HttpApiMiddleware.Service<
	BotAuth,
	{ readonly requires: never; readonly provides: Identity }
>()("@openbot-build/api/AuthApi/BotAuth", {
	requiredForClient: true,
	security: {
		token: HttpApiSecurity.bearer,
		session: HttpApiSecurity.apiKey({ in: "cookie", key: SessionCookie }),
	},
	error: [
		...AuthErrors,
		ForbiddenOrigin.pipe(HttpApiSchema.status(403)),
		OrganizationRequired.pipe(HttpApiSchema.status(400)),
		RateLimited.pipe(HttpApiSchema.status(429)),
	],
}) {}
/**
 * Finds the account of a request that does not act in one organization,
 * such as creating an organization or using `/v1/platform`.
 * It accepts the same credentials as `BotAuth`.
 * @effect-expect-leaking HttpServerRequest | ParsedSearchParams | RouteContext
 */
export class AccountAuth extends HttpApiMiddleware.Service<
	AccountAuth,
	{ readonly requires: never; readonly provides: Account }
>()("@openbot-build/api/AuthApi/AccountAuth", {
	requiredForClient: true,
	security: {
		token: HttpApiSecurity.bearer,
		session: HttpApiSecurity.apiKey({ in: "cookie", key: SessionCookie }),
	},
	error: [...AuthErrors, ForbiddenOrigin.pipe(HttpApiSchema.status(403))],
}) {}
export class SessionAuth extends HttpApiMiddleware.Service<
	SessionAuth,
	{ readonly requires: never; readonly provides: AuthSession }
>()("@openbot-build/api/AuthApi/SessionAuth", {
	requiredForClient: true,
	security: {
		session: HttpApiSecurity.apiKey({ in: "cookie", key: SessionCookie }),
	},
	error: AuthErrors,
}) {}
export class OriginCheck extends HttpApiMiddleware.Service<OriginCheck>()(
	"@openbot-build/api/AuthApi/OriginCheck",
	{ error: ForbiddenOrigin.pipe(HttpApiSchema.status(403)) },
) {}
export class NoStore extends HttpApiMiddleware.Service<NoStore>()(
	"@openbot-build/api/AuthApi/NoStore",
) {}
export const AccountApi = HttpApiGroup.make("account")
	.add(
		HttpApiEndpoint.get("session", "/auth/session", { success: SessionInfo }),
	)
	.middleware(SessionAuth)
	.middleware(NoStore)

export const SignInRequest = Schema.Struct({
	/**
	 * The email of the person. OpenBot uses its domain to find the SSO connection
	 * of an organization. Leave it out to use the sign-in provider of the platform.
	 */
	email: Schema.optionalKey(
		Schema.String.check(
			Schema.isMaxLength(320),
			Schema.isPattern(/^[^@\s]+@[^@\s]+$/),
		),
	),
	returnTo: Schema.optionalKey(ReturnTo),
})
export type SignInRequest = typeof SignInRequest.Type
export const SignInStart = Schema.Struct({
	/** Send the browser to this address. */
	url: Schema.String,
})
/** The organization of this email domain needs its SSO connection, and that connection does not work now. */
export class SignInUnavailable extends Schema.TaggedError<SignInUnavailable>()(
	"SignInUnavailable",
	{},
) {}
/** Start a browser sign-in. It needs no credential. */
export const SignInApi = HttpApiGroup.make("signIn")
	.add(
		HttpApiEndpoint.post("signIn", "/auth/sign-in", {
			payload: SignInRequest,
			success: SignInStart,
			error: [
				SignInUnavailable.pipe(HttpApiSchema.status(503)),
				AuthenticationUnavailable.pipe(HttpApiSchema.status(503)),
			],
		}),
	)
	.middleware(OriginCheck)
	.middleware(NoStore)
