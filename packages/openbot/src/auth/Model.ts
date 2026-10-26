import { Settings as Api } from "@openbot-build/api"
import { DateTime, Effect, Option, Schema, String as Str } from "effect"

export const Timestamp = Schema.String.check(
	Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
	Schema.makeFilter((value) =>
		Option.exists(
			DateTime.make(value),
			(date) =>
				Str.slice(0, 19)(DateTime.formatIso(date)) === Str.slice(0, 19)(value),
		),
	),
)

export const Credential = Schema.Redacted(Schema.NonEmptyString)
const SharedConfiguration = Schema.Struct({
	publicOrigin: Api.PublicOrigin.check(
		Schema.makeFilter(Str.startsWith("https://"), {
			message: "Expected a canonical HTTPS origin",
		}),
	),
	secret: Schema.Redacted(Schema.String.check(Schema.isMinLength(32))),
	sessionTtlMs: Schema.Int.check(Schema.isGreaterThan(0)).pipe(
		Schema.withDecodingDefault(Effect.succeed(30 * 24 * 60 * 60 * 1000)),
	),
})
export const OidcConfiguration = Schema.Struct({
	...SharedConfiguration.fields,
	mode: Schema.Literal("oidc").pipe(
		Schema.withDecodingDefault(Effect.succeed("oidc")),
	),
	issuer: Api.Issuer,
	clientId: Schema.NonEmptyString,
	clientSecret: Schema.optional(Credential),
})
export const DevelopmentConfiguration = Schema.Struct({
	...SharedConfiguration.fields,
	mode: Schema.Literal("development"),
	// The development server runs on this computer, so plain HTTP is enough.
	publicOrigin: Api.PublicOrigin.check(
		Schema.makeFilter(
			// The filter of `Api.PublicOrigin` does not stop the checks after it,
			// so this check can see a value that is not a URL.
			(value) =>
				URL.canParse(value) && Api.isLoopbackHost(new URL(value).hostname),
			{
				message: "Development authentication needs an origin on this computer",
			},
		),
	),
})
/** The platform has no sign-in provider. People sign in through the SSO connections of organizations. */
export const NoProviderConfiguration = Schema.Struct({
	...SharedConfiguration.fields,
	mode: Schema.Literal("none"),
})
export const Configuration = Schema.Union([
	OidcConfiguration,
	DevelopmentConfiguration,
	NoProviderConfiguration,
])
export type Configuration = typeof Configuration.Encoded
export const Profile = Schema.Struct({
	name: Schema.optional(Schema.String),
	email: Schema.optional(Schema.String),
	emailVerified: Schema.optional(Schema.Boolean),
})
export type Profile = typeof Profile.Type
export const Membership = Schema.Struct({
	organizationId: Schema.String,
	name: Schema.String,
	status: Schema.Literals(["active", "suspended"]),
	roles: Schema.Array(Schema.String),
})
/** A signed-in account, its organizations, and whether it is a platform admin. */
export const SessionInfo = Schema.Struct({
	userId: Schema.NonEmptyString,
	profile: Profile,
	memberships: Schema.Array(Membership),
	platformAdmin: Schema.Boolean,
	expiresAt: Timestamp,
})
export type SessionInfo = typeof SessionInfo.Type
export class AuthConfigurationError extends Schema.TaggedError<
	AuthConfigurationError,
	{ readonly brand: unique symbol }
>()("AuthConfigurationError", {
	field: Schema.Literals(["configuration", "publicOrigin"]),
}) {}
/**
 * Sign-in cannot work now. `settings` means that OpenBot cannot read the
 * platform settings, or that the platform has none yet.
 */
export class AuthUnavailable extends Schema.TaggedError<
	AuthUnavailable,
	{ readonly brand: unique symbol }
>()("AuthUnavailable", {
	dependency: Schema.Literals(["provider", "storage", "crypto", "settings"]),
}) {}
export class CredentialRejected extends Schema.TaggedError<
	CredentialRejected,
	{ readonly brand: unique symbol }
>()(
	"CredentialRejected",
	/** `membership` means the credential is valid, but the account is not an active member. */
	{ kind: Schema.Literals(["session", "token", "membership"]) },
) {}
