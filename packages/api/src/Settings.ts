import { Config } from "@openbot-build/core"
import { Schema, String as Str } from "effect"
import { HttpApiSchema } from "effect/http-api"
import { BotId } from "./BotsApi.ts"
import { Restriction } from "./AppIndexApi.ts"
import { CeilingInput, CeilingSchema } from "./Authorization.ts"
import { RoleId } from "./Roles.ts"
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

/** True when the host is this computer. Every name under .localhost is (RFC 6761). */
export const isLoopbackHost = (hostname: string): boolean =>
	["localhost", "127.0.0.1", "[::1]"].includes(hostname) ||
	Str.endsWith(".localhost")(hostname)

/**
 * An origin with no path, such as `https://api.example.com`. It must use HTTPS.
 * Only an origin on this computer, such as `http://openbot.localhost`, may use
 * plain HTTP.
 */
export const PublicOrigin = Schema.NonEmptyString.check(
	Schema.makeFilter(
		(value) => {
			if (!URL.canParse(value)) return false
			const origin = new URL(value)
			return (
				(origin.protocol === "https:" ||
					(origin.protocol === "http:" && isLoopbackHost(origin.hostname))) &&
				origin.origin === value &&
				origin.username === "" &&
				origin.password === ""
			)
		},
		{
			message:
				"Expected a canonical HTTPS origin, or an HTTP origin on this computer",
		},
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
				!Str.endsWith("/")(value)
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

export const OrganizationCreation = Schema.Literals([
	"anyone",
	"platform_admins",
])
export type OrganizationCreation = typeof OrganizationCreation.Type

/**
 * The limits of Code Mode. They protect the host, not the Bot. Every instance
 * uses the same limits, so a program acts the same when another instance runs it again.
 */
export const CodeMode = Schema.Struct({
	/** When false, Bots do not get the Code Mode tools. */
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
	/** The model calls of one Bot. */
	bot: Schema.NullOr(TokenRate),
	/** The model calls of work that one user token started. */
	token: Schema.NullOr(TokenRate),
})
export type TokenRateLimits = typeof TokenRateLimits.Type
export const tokenRateDefaults: TokenRateLimits = {
	organization: null,
	member: null,
	bot: null,
	token: null,
}

/** An HTTP or HTTPS address with no path, such as `https://s3.example.com`. */
export const StorageEndpoint = Schema.NonEmptyString.check(
	Schema.makeFilter(
		(value) => {
			if (!URL.canParse(value)) return false
			const endpoint = new URL(value)
			return (
				(endpoint.protocol === "https:" || endpoint.protocol === "http:") &&
				endpoint.origin === value &&
				endpoint.username === "" &&
				endpoint.password === ""
			)
		},
		{ message: "Expected an HTTP or HTTPS origin with no path" },
	),
)
/** A bucket name of S3. */
export const BucketName = Schema.String.check(
	Schema.isPattern(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
)
const storageFields = {
	/** The address where OpenBot reaches the storage. */
	endpoint: StorageEndpoint,
	/**
	 * The address where clients put files with a signed upload. Null means
	 * `endpoint`. Use it when OpenBot reaches the storage on a private network.
	 */
	publicEndpoint: Schema.NullOr(StorageEndpoint),
	region: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
	bucket: BucketName,
	accessKeyId: Schema.String.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(256),
	),
	/**
	 * Put the bucket in the path, as in `https://host/bucket/key`. Most storage
	 * that is not AWS, such as MinIO, needs it.
	 */
	forcePathStyle: Schema.Boolean,
}
/** An object storage that speaks the S3 API, such as AWS S3, Cloudflare R2 or MinIO. */
export const FileStorage = Schema.Struct({
	...storageFields,
	secretAccessKey: SecretState,
})
export type FileStorage = typeof FileStorage.Type
export const FileStorageInput = Schema.Struct({
	...storageFields,
	/** Leave it out to keep the current secret. */
	secretAccessKey: Schema.optionalKey(SecretInput),
})
export type FileStorageInput = typeof FileStorageInput.Type

/** The ways that clients can upload files. */
export const FileUploads = Schema.Struct({
	/** `POST /v1/files`: the bytes go through OpenBot. */
	server: Schema.Boolean,
	/** `POST /v1/files/uploads`: the client puts the bytes in storage itself, at a signed address. */
	direct: Schema.Boolean,
})
export type FileUploads = typeof FileUploads.Type

const fileLimits = {
	uploads: FileUploads,
	/** The largest file, in bytes. */
	maxBytes: Schema.Int.check(
		Schema.isBetween({ minimum: 1, maximum: 5 * 1024 * 1024 * 1024 }),
	),
	/**
	 * The most bytes that one member may keep in files. Pending and ready files
	 * both count. Null means no limit.
	 */
	quotaBytes: Schema.NullOr(
		Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 ** 50 })),
	),
	/** The media types that people can upload, such as `image/png`. `image/*` takes every image. */
	mediaTypes: Schema.Array(
		Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(255)),
	).check(Schema.isMaxLength(100)),
	/**
	 * How long a file that no Chat uses stays, in milliseconds. After that,
	 * OpenBot deletes it. A file that a Chat uses stays until the Chat is deleted.
	 */
	unusedMs: Schema.Int.check(
		Schema.isBetween({ minimum: 60_000, maximum: 365 * 24 * 60 * 60 * 1000 }),
	),
}
/** Files that people give to Bots. */
export const Files = Schema.Struct({
	/** Null means no storage, so nobody can upload files. */
	storage: Schema.NullOr(FileStorage),
	...fileLimits,
})
export type Files = typeof Files.Type
export const FilesInput = Schema.Struct({
	/** Leave it out to keep the current storage. Null removes it. */
	storage: Schema.optionalKey(Schema.NullOr(FileStorageInput)),
	uploads: Schema.optionalKey(fileLimits.uploads),
	maxBytes: Schema.optionalKey(fileLimits.maxBytes),
	quotaBytes: Schema.optionalKey(fileLimits.quotaBytes),
	mediaTypes: Schema.optionalKey(fileLimits.mediaTypes),
	unusedMs: Schema.optionalKey(fileLimits.unusedMs),
})
export type FilesInput = typeof FilesInput.Type
export const fileDefaults: Omit<Files, "storage"> = {
	uploads: { server: true, direct: true },
	maxBytes: 20 * 1024 * 1024,
	quotaBytes: null,
	mediaTypes: [
		"image/png",
		"image/jpeg",
		"image/gif",
		"image/webp",
		"application/pdf",
		"text/plain",
	],
	unusedMs: 24 * 60 * 60 * 1000,
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
	/** Deny rules that apply in every organization, before its own policies. */
	ceiling: CeilingSchema,
	/** Apps that the App Index hides, with the reason. */
	appRestrictions: Schema.Array(Restriction).check(Schema.isMaxLength(1000)),
	codeMode: CodeMode,
	rateLimit: RateLimit,
	/** The highest token rates. An organization can only set lower ones. */
	tokenRate: TokenRateLimits,
	files: Files,
	updatedAt: Schema.String,
})
export type PlatformSettings = typeof PlatformSettings.Type
export const UpdatePlatformSettingsRequest = Schema.Struct({
	expectedVersion: Version,
	publicOrigin: Schema.optionalKey(PublicOrigin),
	identityProvider: Schema.optionalKey(Schema.NullOr(IdentityProviderInput)),
	organizationCreation: Schema.optionalKey(OrganizationCreation),
	ceiling: Schema.optionalKey(CeilingInput),
	appRestrictions: Schema.optionalKey(
		Schema.Array(Restriction).check(Schema.isMaxLength(1000)),
	),
	codeMode: Schema.optionalKey(CodeMode),
	rateLimit: Schema.optionalKey(RateLimit),
	tokenRate: Schema.optionalKey(TokenRateLimits),
	files: Schema.optionalKey(FilesInput),
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
/**
 * How long delegated work may run before it pauses and asks its decider, in
 * milliseconds. Work that sets no time limit, such as the work of a trigger, uses it.
 */
export const DelegationTimeLimit = Schema.Int.check(
	Schema.isBetween({ minimum: 60 * 1000, maximum: 30 * 24 * 60 * 60 * 1000 }),
)
/** One hour. */
export const delegationTimeLimitDefault = 60 * 60 * 1000
/**
 * How long a tool call runs in its Turn before it goes on in the background, in
 * milliseconds. Zero sends every call to the background at once.
 */
export const ToolForegroundBudget = Schema.Int.check(
	Schema.isBetween({ minimum: 0, maximum: 10 * 60 * 1000 }),
)
/** Thirty seconds. */
export const toolForegroundBudgetDefault = 30 * 1000
/** How long a tool call may run in all, in milliseconds. After that it stops and fails. */
export const ToolMaxDuration = Schema.Int.check(
	Schema.isBetween({ minimum: 1000, maximum: 24 * 60 * 60 * 1000 }),
)
/** One hour. */
export const toolMaxDurationDefault = 60 * 60 * 1000
/** How many tool calls of one Chat may run in the background at one time. */
export const MaxBackgroundOperations = Schema.Int.check(
	Schema.isBetween({ minimum: 0, maximum: 100 }),
)
export const maxBackgroundOperationsDefault = 8
export const DefaultRoles = Schema.Array(RoleId).check(Schema.isMinLength(1))

export const OrganizationSettings = Schema.Struct({
	version: Version,
	/**
	 * The model that judges Rules. It can be a language model or a decision
	 * model. Null means that no model judges Rules.
	 */
	rulesModel: Schema.NullOr(Config.Selection),
	/** The model of the memory Bot of each Bot. Null means that Bots learn no memory. */
	botMemoryModel: Schema.NullOr(Config.Selection),
	/** Let the memory Bot learn from Chats and add to the input of Turns. */
	botMemory: Schema.Boolean,
	requestTimeoutMs: RequestTimeout,
	/** The time limit of delegated work that sets none itself. */
	delegationTimeLimitMs: DelegationTimeLimit,
	/** How plans are approved when no member, Bot or Chat sets it. */
	planApproval: PlanApproval,
	toolForegroundBudgetMs: ToolForegroundBudget,
	toolMaxDurationMs: ToolMaxDuration,
	maxBackgroundOperations: MaxBackgroundOperations,
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
	botMemoryModel: Schema.optionalKey(Schema.NullOr(Config.Selection)),
	botMemory: Schema.optionalKey(Schema.Boolean),
	requestTimeoutMs: Schema.optionalKey(RequestTimeout),
	delegationTimeLimitMs: Schema.optionalKey(DelegationTimeLimit),
	planApproval: Schema.optionalKey(PlanApproval),
	toolForegroundBudgetMs: Schema.optionalKey(ToolForegroundBudget),
	toolMaxDurationMs: Schema.optionalKey(ToolMaxDuration),
	maxBackgroundOperations: Schema.optionalKey(MaxBackgroundOperations),
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
	/** How the plans of your Bots are approved. `null` follows the organization. */
	planApproval: Schema.NullOr(PlanApproval),
	/**
	 * The Bot that a trigger without a Bot gives its task to. Clients talk to it first.
	 * It is one of your own top Bots or a shared Bot. `null` means that you have none.
	 */
	defaultBot: Schema.NullOr(BotId),
	updatedAt: Schema.String,
})
export type MemberSettings = typeof MemberSettings.Type
export const UpdateMemberSettingsRequest = Schema.Struct({
	expectedVersion: Version,
	planApproval: Schema.optionalKey(Schema.NullOr(PlanApproval)),
	/** `null` removes your default Bot. */
	defaultBot: Schema.optionalKey(Schema.NullOr(BotId)),
})
export type UpdateMemberSettingsRequest =
	typeof UpdateMemberSettingsRequest.Type

/** Someone changed the settings after you read them. Read them again, then retry. */
export class SettingsConflict extends Schema.TaggedError<
	SettingsConflict,
	{ readonly brand: unique symbol }
>()("SettingsConflict", { version: Version }) {}
/** A value in the change is not valid, such as a role that does not exist. */
export class SettingsInvalid extends Schema.TaggedError<
	SettingsInvalid,
	{ readonly brand: unique symbol }
>()("SettingsInvalid", { message: Schema.String }) {}
export class SettingsUnavailable extends Schema.TaggedError<
	SettingsUnavailable,
	{ readonly brand: unique symbol }
>()("SettingsUnavailable", {}) {}
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
export class SetupRequired extends Schema.TaggedError<
	SetupRequired,
	{ readonly brand: unique symbol }
>()("SetupRequired", {}) {}
