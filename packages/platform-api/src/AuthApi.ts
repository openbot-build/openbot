import { Context, Redacted, Schema } from "effect"
import {
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiMiddleware,
	HttpApiSchema,
	HttpApiSecurity,
} from "effect/http-api"
import { Identity } from "./Identity.ts"

export const SessionCookie = "__Host-openbot-session"
export const LoginCookie = "__Host-openbot-login"
/**
 * A same-origin path to return to after a browser sign-in or authorization round trip.
 * Platform serves no pages. A client on the same origin owns these paths.
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
export class InvalidAccountRequest extends Schema.TaggedError<InvalidAccountRequest>()(
	"InvalidAccountRequest",
	{},
) {}
export class ForbiddenOrigin extends Schema.TaggedError<ForbiddenOrigin>()(
	"ForbiddenOrigin",
	{},
) {}
export const AuthErrors = [
	AuthenticationRequired.pipe(HttpApiSchema.status(401)),
	AuthenticationUnavailable.pipe(HttpApiSchema.status(503)),
] as const
export const SessionInfo = Schema.Struct({
	identity: Schema.Struct({ userId: Schema.String, tenantId: Schema.String }),
	profile: Schema.Struct({
		name: Schema.optionalKey(Schema.String),
		email: Schema.optionalKey(Schema.String),
		emailVerified: Schema.optionalKey(Schema.Boolean),
	}),
	expiresAt: Schema.String,
})
export class AuthSession extends Context.Service<
	AuthSession,
	{
		readonly session: typeof SessionInfo.Type
		readonly credential: Redacted.Redacted<string>
	}
>()("@openbot-build/platform-api/AuthApi/AuthSession") {}
/**
 * Authorizes ordinary business operations with an API key (`Authorization: Bearer`).
 * Same-origin browser clients can use the signed-in session Cookie instead.
 * Both schemes read their credential from the current request.
 * @effect-expect-leaking HttpServerRequest | ParsedSearchParams | RouteContext
 */
export class AgentAuth extends HttpApiMiddleware.Service<
	AgentAuth,
	{ readonly requires: never; readonly provides: Identity }
>()("@openbot-build/platform-api/AuthApi/AgentAuth", {
	requiredForClient: true,
	security: {
		apiKey: HttpApiSecurity.bearer,
		session: HttpApiSecurity.apiKey({ in: "cookie", key: SessionCookie }),
	},
	error: [...AuthErrors, ForbiddenOrigin.pipe(HttpApiSchema.status(403))],
}) {}
export class SessionAuth extends HttpApiMiddleware.Service<
	SessionAuth,
	{ readonly requires: never; readonly provides: AuthSession }
>()("@openbot-build/platform-api/AuthApi/SessionAuth", {
	requiredForClient: true,
	security: {
		session: HttpApiSecurity.apiKey({ in: "cookie", key: SessionCookie }),
	},
	error: AuthErrors,
}) {}
export class OriginCheck extends HttpApiMiddleware.Service<OriginCheck>()(
	"@openbot-build/platform-api/AuthApi/OriginCheck",
	{ error: ForbiddenOrigin.pipe(HttpApiSchema.status(403)) },
) {}
export class NoStore extends HttpApiMiddleware.Service<NoStore>()(
	"@openbot-build/platform-api/AuthApi/NoStore",
) {}
const inputErrors = [
	...AuthErrors,
	InvalidAccountRequest.pipe(HttpApiSchema.status(400)),
]
export const LoginApi = HttpApiGroup.make("login")
	.add(
		HttpApiEndpoint.get("login", "/auth/login", {
			query: { returnTo: Schema.optionalKey(ReturnTo) },
			success: HttpApiSchema.Empty(303),
			error: inputErrors,
		}),
		HttpApiEndpoint.get("callback", "/auth/callback", {
			success: HttpApiSchema.Empty(303),
			error: inputErrors,
		}),
		HttpApiEndpoint.post("logout", "/auth/logout", {
			success: HttpApiSchema.NoContent,
			error: AuthErrors,
		}).middleware(OriginCheck),
	)
	.middleware(NoStore)
export const AccountApi = HttpApiGroup.make("account")
	.add(
		HttpApiEndpoint.get("session", "/auth/session", { success: SessionInfo }),
	)
	.middleware(SessionAuth)
	.middleware(NoStore)
