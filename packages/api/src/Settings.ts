import { Config } from "@openbot-build/core"
import { Schema } from "effect"
import { HttpApiSchema } from "effect/http-api"
import { Restriction } from "./AppIndexApi.ts"
import * as Memory from "./Memory.ts"
import { Policy, RoleId } from "./Permissions.ts"
import { PlanApproval } from "./PlanApproval.ts"

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

/**
 * The limits of Code Mode. They protect the host, not the Agent. Every instance
 * uses the same limits, so a program acts the same when another instance runs it again.
 */
export const CodeMode = Schema.Struct({
	/** When false, Agents do not get the Code Mode tools. */
	enabled: Schema.Boolean,
	/** How long one run of a program may take, in milliseconds. Time spent waiting for decisions does not count. */
	timeoutMs: Schema.Int.check(
		Schema.isBetween({ minimum: 100, maximum: 600_000 }),
	),
	/** How much memory a program may use, in megabytes. */
	memoryMb: Schema.Int.check(Schema.isBetween({ minimum: 8, maximum: 1024 })),
	/** The largest return value of a program, and the most log text, in bytes. */
	outputBytes: Schema.Int.check(
		Schema.isBetween({ minimum: 1024, maximum: 4 * 1024 * 1024 }),
	),
})
export type CodeMode = typeof CodeMode.Type
export const codeModeDefaults: CodeMode = {
	enabled: false,
	timeoutMs: 30_000,
	memoryMb: 64,
	outputBytes: 64 * 1024,
}

/**
 * The limit on requests to the API. Each user token, or each signed-in person
 * without a token, counts on its own. Every instance shares the count.
 */
export const RateLimit = Schema.Struct({
	/** Requests in one minute. Null means no limit. */
	requestsPerMinute: Schema.NullOr(
		Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 })),
	),
})
export type RateLimit = typeof RateLimit.Type
export const rateLimitDefaults: RateLimit = { requestsPerMinute: null }

/**
 * A limit on the model tokens of one scope, as a token bucket. The bucket holds
 * up to `burstTokens` and fills at `tokensPerSecond`. Model calls take their
 * input and output tokens from it. When it is empty, OpenBot slows the work
 * down: it sends the output on more slowly, and the next model call waits.
 * It never refuses the work.
 */
export const TokenRate = Schema.Struct({
	tokensPerSecond: Schema.Int.check(
		Schema.isBetween({ minimum: 1, maximum: 10_000_000 }),
	),
	burstTokens: Schema.Int.check(
		Schema.isBetween({ minimum: 1, maximum: 100_000_000 }),
	),
})
export type TokenRate = typeof TokenRate.Type
/** The token rate limit of each scope. Null means no limit for that scope. */
export const TokenRateLimits = Schema.Struct({
	/** All model calls of the organization. */
	organization: Schema.NullOr(TokenRate),
	/** The model calls that work for one member. */
	member: Schema.NullOr(TokenRate),
	/** The model calls of one Agent. */
	agent: Schema.NullOr(TokenRate),
	/** The model calls of work that one user token started. */
	token: Schema.NullOr(TokenRate),
})
export type TokenRateLimits = typeof TokenRateLimits.Type
export const tokenRateDefaults: TokenRateLimits = {
	organization: null,
	member: null,
	agent: null,
	token: null,
}

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
	codeMode: CodeMode,
	rateLimit: RateLimit,
	/** The highest token rates. An organization can only set lower ones. */
	tokenRate: TokenRateLimits,
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
	codeMode: Schema.optionalKey(CodeMode),
	rateLimit: Schema.optionalKey(RateLimit),
	tokenRate: Schema.optionalKey(TokenRateLimits),
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
	/** The model that judges Rules. Null means that no model judges Rules. */
	rulesModel: Schema.NullOr(Config.Selection),
	/** The model that learns Agent memory. Null means that Agents learn no memory. */
	agentMemoryModel: Schema.NullOr(Config.Selection),
	/** The decision model, such as Jev. It must be a model of type `decision`. Null means none. */
	decisionModel: Schema.NullOr(Config.Selection),
	/** The memory switches of a new Session. */
	memory: Memory.Settings,
	/** Learn Agent memory after each Turn. */
	agentMemory: Schema.Boolean,
	requestTimeoutMs: RequestTimeout,
	/** How plans are approved when no member, Agent or Session sets it. */
	planApproval: PlanApproval,
	appReadRules: AppReadRules,
	/** The roles of a new member. */
	defaultRoles: DefaultRoles,
	/** People with a verified email in a verified domain of the organization join when they sign in. */
	joinByDomain: Schema.Boolean,
	/**
	 * The token rates of the organization. Where the platform sets a lower
	 * rate, the lower rate applies.
	 */
	tokenRate: TokenRateLimits,
	updatedAt: Schema.String,
})
export type OrganizationSettings = typeof OrganizationSettings.Type
export const UpdateOrganizationSettingsRequest = Schema.Struct({
	expectedVersion: Version,
	rulesModel: Schema.optionalKey(Schema.NullOr(Config.Selection)),
	agentMemoryModel: Schema.optionalKey(Schema.NullOr(Config.Selection)),
	decisionModel: Schema.optionalKey(Schema.NullOr(Config.Selection)),
	memory: Schema.optionalKey(Memory.Settings),
	agentMemory: Schema.optionalKey(Schema.Boolean),
	requestTimeoutMs: Schema.optionalKey(RequestTimeout),
	planApproval: Schema.optionalKey(PlanApproval),
	appReadRules: Schema.optionalKey(AppReadRules),
	defaultRoles: Schema.optionalKey(DefaultRoles),
	joinByDomain: Schema.optionalKey(Schema.Boolean),
	tokenRate: Schema.optionalKey(TokenRateLimits),
})
export type UpdateOrganizationSettingsRequest =
	typeof UpdateOrganizationSettingsRequest.Type

/** The settings of one member in one organization. */
export const MemberSettings = Schema.Struct({
	version: Version,
	/** How the plans of your Agents are approved. `null` follows the organization. */
	planApproval: Schema.NullOr(PlanApproval),
	updatedAt: Schema.String,
})
export type MemberSettings = typeof MemberSettings.Type
export const UpdateMemberSettingsRequest = Schema.Struct({
	expectedVersion: Version,
	planApproval: Schema.optionalKey(Schema.NullOr(PlanApproval)),
})
export type UpdateMemberSettingsRequest =
	typeof UpdateMemberSettingsRequest.Type

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
