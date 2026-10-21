import { DateTime, Effect, Option, Schema } from "effect"

export const Timestamp = Schema.String.check(
	Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
	Schema.makeFilter((value) =>
		Option.exists(
			DateTime.make(value),
			(date) => DateTime.formatIso(date).slice(0, 19) === value.slice(0, 19),
		),
	),
)

export const Credential = Schema.Redacted(Schema.NonEmptyString)
const SharedConfiguration = Schema.Struct({
	publicOrigin: Schema.NonEmptyString.check(
		Schema.makeFilter(
			(value) => {
				if (!URL.canParse(value)) return false
				const origin = new URL(value)
				return (
					origin.protocol === "https:" &&
					origin.origin === value &&
					origin.username === "" &&
					origin.password === ""
				)
			},
			{ message: "Expected a canonical HTTPS origin" },
		),
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
	issuer: Schema.NonEmptyString.check(
		Schema.makeFilter(
			(value) => {
				if (!URL.canParse(value)) return false
				const issuer = new URL(value)
				return (
					issuer.protocol === "https:" &&
					issuer.username === "" &&
					issuer.password === "" &&
					issuer.search === "" &&
					issuer.hash === "" &&
					!value.endsWith("/")
				)
			},
			{ message: "Expected an HTTPS issuer without a trailing slash" },
		),
	),
	clientId: Schema.NonEmptyString,
	clientSecret: Schema.optional(Credential),
})
export const DevelopmentConfiguration = Schema.Struct({
	...SharedConfiguration.fields,
	mode: Schema.Literal("development"),
	publicOrigin: SharedConfiguration.fields.publicOrigin.check(
		Schema.makeFilter(
			(value) =>
				["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname),
			{
				message: "Development authentication needs a loopback HTTPS origin",
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
export class AuthConfigurationError extends Schema.TaggedError<AuthConfigurationError>()(
	"AuthConfigurationError",
	{ field: Schema.Literals(["configuration", "publicOrigin"]) },
) {}
export class AuthUnavailable extends Schema.TaggedError<AuthUnavailable>()(
	"AuthUnavailable",
	{ dependency: Schema.Literals(["provider", "storage", "crypto"]) },
) {}
export class CredentialRejected extends Schema.TaggedError<CredentialRejected>()(
	"CredentialRejected",
	/** `membership` means the credential is valid, but the account is not an active member. */
	{ kind: Schema.Literals(["session", "token", "membership"]) },
) {}
