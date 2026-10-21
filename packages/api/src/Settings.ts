import { Config } from "@openbot-build/core"
import { Schema } from "effect"
import { HttpApiSchema } from "effect/http-api"
import { Restriction } from "./AppIndexApi.ts"
import * as Memory from "./Memory.ts"
import { Policy, RoleId } from "./Permissions.ts"

/**
 * Settings that every instance of OpenBot must share live in the database.
 * Each settings document has a version. A change must name the version that it
 * read, so two admins cannot overwrite each other by mistake.
 */
export const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** A secret goes in, but it never comes out. The hint shows its last characters. */
export const SecretInput = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(4096),
)
export const SecretState = Schema.Struct({
	set: Schema.Boolean,
	hint: Schema.NullOr(Schema.String),
})
export type SecretState = typeof SecretState.Type

/** An HTTPS origin with no path, such as `https://api.example.com`. */
export const PublicOrigin = Schema.NonEmptyString.check(
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
)
/** The HTTPS address of an OpenID Connect provider, with no trailing slash. */
export const Issuer = Schema.NonEmptyString.check(
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
)
export const ClientId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(512),
)

/** The OpenID Connect provider that signs people in to the whole platform. */
export const IdentityProvider = Schema.Struct({
	issuer: Issuer,
	clientId: ClientId,
	/** Not set means a public client that uses PKCE only. */
	clientSecret: SecretState,
})
export type IdentityProvider = typeof IdentityProvider.Type
export const IdentityProviderInput = Schema.Struct({
	issuer: Issuer,
	clientId: ClientId,
	/** Leave it out to keep the current secret. Send null for a public client. */
	clientSecret: Schema.optionalKey(Schema.NullOr(SecretInput)),
})
export type IdentityProviderInput = typeof IdentityProviderInput.Type

/** A platform policy can only deny. It applies in every organization. */
export const CeilingPolicy = Schema.Struct({
	...Policy.fields,
	effect: Schema.Literal("deny"),
})
export const CeilingPolicies = Schema.Array(CeilingPolicy).check(
	Schema.isMaxLength(50),
)

export const OrganizationCreation = Schema.Literals([
	"anyone",
	"platform_admins",
])
export type OrganizationCreation = typeof OrganizationCreation.Type

export const PlatformSettings = Schema.Struct({
	version: Version,
	/**
	 * The public HTTPS address of OpenBot. A change signs everyone out and
	 * changes the sign-in redirect URI.
	 */
	publicOrigin: PublicOrigin,
	/**
	 * Null means that the platform has no sign-in provider of its own.
	 * Then people can only sign in through the SSO connection of an organization.
	 */
	identityProvider: Schema.NullOr(IdentityProvider),
	/** Who can create a new organization. */
	organizationCreation: OrganizationCreation,
	/** Deny policies that apply in every organization, before its own policies. */
	policyCeiling: CeilingPolicies,
	/** Apps that the App Index hides, with the reason. */
	appRestrictions: Schema.Array(Restriction).check(Schema.isMaxLength(1000)),
	updatedAt: Schema.String,
})
export type PlatformSettings = typeof PlatformSettings.Type
export const UpdatePlatformSettingsRequest = Schema.Struct({
	expectedVersion: Version,
	publicOrigin: Schema.optionalKey(PublicOrigin),
	identityProvider: Schema.optionalKey(Schema.NullOr(IdentityProviderInput)),
	organizationCreation: Schema.optionalKey(OrganizationCreation),
	policyCeiling: Schema.optionalKey(CeilingPolicies),
	appRestrictions: Schema.optionalKey(
		Schema.Array(Restriction).check(Schema.isMaxLength(1000)),
	),
})
export type UpdatePlatformSettingsRequest =
	typeof UpdatePlatformSettingsRequest.Type

/** Owners of OpenBot say which App tools only read. App annotations never do. */
export const AppReadRule = Schema.Struct({
	cardUrl: Schema.String.check(Schema.isMinLength(1)),
	tool: Schema.String.check(Schema.isMinLength(1)),
})
export type AppReadRule = typeof AppReadRule.Type
export const AppReadRules = Schema.Array(AppReadRule).check(
	Schema.isMaxLength(1000),
)
/** How long a capability request waits for a decision, in milliseconds. */
export const RequestTimeout = Schema.Int.check(
	Schema.isBetween({ minimum: 1000, maximum: 7 * 24 * 60 * 60 * 1000 }),
)
export const DefaultRoles = Schema.Array(RoleId).check(Schema.isMinLength(1))

export const OrganizationSettings = Schema.Struct({
	version: Version,
	/** The model of a new Session. Null means the first model in the catalog. */
	defaultModel: Schema.NullOr(Config.Selection),
	/** The model that judges Rules and learns Agent memory. Null means the default model. */
	helperModel: Schema.NullOr(Config.Selection),
	/** The memory switches of a new Session. */
	memory: Memory.Settings,
	/** Learn Agent memory after each Turn. */
	agentMemory: Schema.Boolean,
	requestTimeoutMs: RequestTimeout,
	appReadRules: AppReadRules,
	/** The roles of a new member. */
	defaultRoles: DefaultRoles,
	/** People with a verified email in a verified domain of the organization join when they sign in. */
	joinByDomain: Schema.Boolean,
	updatedAt: Schema.String,
})
export type OrganizationSettings = typeof OrganizationSettings.Type
export const UpdateOrganizationSettingsRequest = Schema.Struct({
	expectedVersion: Version,
	defaultModel: Schema.optionalKey(Schema.NullOr(Config.Selection)),
	helperModel: Schema.optionalKey(Schema.NullOr(Config.Selection)),
	memory: Schema.optionalKey(Memory.Settings),
	agentMemory: Schema.optionalKey(Schema.Boolean),
	requestTimeoutMs: Schema.optionalKey(RequestTimeout),
	appReadRules: Schema.optionalKey(AppReadRules),
	defaultRoles: Schema.optionalKey(DefaultRoles),
	joinByDomain: Schema.optionalKey(Schema.Boolean),
})
export type UpdateOrganizationSettingsRequest =
	typeof UpdateOrganizationSettingsRequest.Type

/** Someone changed the settings after you read them. Read them again, then retry. */
export class SettingsConflict extends Schema.TaggedError<SettingsConflict>()(
	"SettingsConflict",
	{ version: Version },
) {}
/** A value in the change is not valid, such as a role that does not exist. */
export class SettingsInvalid extends Schema.TaggedError<SettingsInvalid>()(
	"SettingsInvalid",
	{ message: Schema.String },
) {}
export class SettingsUnavailable extends Schema.TaggedError<SettingsUnavailable>()(
	"SettingsUnavailable",
	{},
) {}
export const SettingsErrors = [
	SettingsConflict.pipe(HttpApiSchema.status(409)),
	SettingsInvalid.pipe(HttpApiSchema.status(400)),
	SettingsUnavailable.pipe(HttpApiSchema.status(503)),
] as const

/**
 * Nobody has run `openbot setup` on this platform yet. Until then, every route
 * except `/health` answers with this error and status 503.
 * The server adds this check to its router, not to each group of the contract.
 * A contract middleware on every endpoint makes the type of `OpenBotApi` too
 * long for TypeScript to write into declaration files (error TS7056).
 */
export class SetupRequired extends Schema.TaggedError<SetupRequired>()(
	"SetupRequired",
	{},
) {}
