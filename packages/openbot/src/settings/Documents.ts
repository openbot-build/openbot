import { PlanApproval, Settings as Api } from "@openbot-build/api"
import { Option, Schema } from "effect"

/** The stored form of the file settings. The secret key is sealed. */
export const FilesDocument = Schema.Struct({
	storage: Schema.NullOr(
		Schema.Struct({
			endpoint: Api.FileStorage.fields.endpoint,
			publicEndpoint: Api.FileStorage.fields.publicEndpoint,
			region: Api.FileStorage.fields.region,
			bucket: Api.FileStorage.fields.bucket,
			accessKeyId: Api.FileStorage.fields.accessKeyId,
			forcePathStyle: Api.FileStorage.fields.forcePathStyle,
			secretAccessKey: Schema.String,
			secretAccessKeyHint: Schema.NullOr(Schema.String),
		}),
	),
	uploads: Api.Files.fields.uploads,
	maxBytes: Api.Files.fields.maxBytes,
	/** Missing in documents from before quotas. Then there is no quota. */
	quotaBytes: Schema.optionalKey(Api.Files.fields.quotaBytes),
	mediaTypes: Api.Files.fields.mediaTypes,
	unusedMs: Api.Files.fields.unusedMs,
})
export type FilesDocument = typeof FilesDocument.Type

/**
 * The stored form of the platform settings. Secrets are sealed with the
 * secret keys of the instance, and only this code opens them.
 */
export const PlatformDocument = Schema.Struct({
	publicOrigin: Api.PublicOrigin,
	/** Signs the sign-in cookies of Better Auth. `openbot setup` makes it. */
	authSecret: Schema.String,
	/** Null means that people sign in only through the SSO connections of organizations. */
	identityProvider: Schema.NullOr(
		Schema.Struct({
			issuer: Api.Issuer,
			clientId: Api.ClientId,
			clientSecret: Schema.NullOr(Schema.String),
			clientSecretHint: Schema.NullOr(Schema.String),
		}),
	),
	organizationCreation: Api.OrganizationCreation,
	ceiling: Api.PlatformSettings.fields.ceiling,
	appRestrictions: Api.PlatformSettings.fields.appRestrictions,
	/** Missing in documents from before Code Mode. Then the defaults apply. */
	codeMode: Schema.optionalKey(Api.CodeMode),
	/** Missing in documents from before the rate limit. Then there is no limit. */
	rateLimit: Schema.optionalKey(Api.RateLimit),
	/** Missing in documents from before token rates. Then there is no limit. */
	tokenRate: Schema.optionalKey(Api.TokenRateLimits),
	/** Missing in documents from before files. Then there is no storage. */
	files: Schema.optionalKey(FilesDocument),
})
export type PlatformDocument = typeof PlatformDocument.Type

/** The Code Mode settings of the platform. */
export const codeModeOf = (document: PlatformDocument): Api.CodeMode =>
	document.codeMode ?? Api.codeModeDefaults

/** The token rates of the platform or of an organization. */
export const tokenRateOf = (document: {
	readonly tokenRate?: Api.TokenRateLimits
}): Api.TokenRateLimits => document.tokenRate ?? Api.tokenRateDefaults

/** The file settings of the platform. */
export const filesOf = (document: PlatformDocument): FilesDocument =>
	document.files ?? filesDefaults
/** The quota of each member, or null for no quota. */
export const quotaOf = (document: FilesDocument): number | null =>
	document.quotaBytes ?? null
/** No storage, so nobody can upload files yet. */
export const filesDefaults: FilesDocument = {
	...Api.fileDefaults,
	storage: null,
}

/** The API rate limit of the platform. */
export const rateLimitOf = (document: PlatformDocument): Api.RateLimit =>
	document.rateLimit ?? Api.rateLimitDefaults

/** The time limit of delegated work that sets none itself. */
export const delegationTimeLimitOf = (document: {
	readonly delegationTimeLimitMs?: number
}): number => document.delegationTimeLimitMs ?? Api.delegationTimeLimitDefault

/** The limits of the background tool calls of an organization. */
export const operationsOf = (document: {
	readonly toolForegroundBudgetMs?: number
	readonly toolMaxDurationMs?: number
	readonly maxBackgroundOperations?: number
}) => ({
	toolForegroundBudgetMs:
		document.toolForegroundBudgetMs ?? Api.toolForegroundBudgetDefault,
	toolMaxDurationMs: document.toolMaxDurationMs ?? Api.toolMaxDurationDefault,
	maxBackgroundOperations:
		document.maxBackgroundOperations ?? Api.maxBackgroundOperationsDefault,
})

export const OrganizationDocument = Schema.Struct({
	rulesModel: Api.OrganizationSettings.fields.rulesModel,
	botMemoryModel: Api.OrganizationSettings.fields.botMemoryModel,
	botMemory: Schema.Boolean,
	requestTimeoutMs: Api.RequestTimeout,
	/** Missing in documents from before delegation limits. Then it is one hour. */
	delegationTimeLimitMs: Schema.optionalKey(Api.DelegationTimeLimit),
	planApproval: PlanApproval.PlanApproval,
	/** Missing in documents from before background tool calls. Then the defaults apply. */
	toolForegroundBudgetMs: Schema.optionalKey(Api.ToolForegroundBudget),
	toolMaxDurationMs: Schema.optionalKey(Api.ToolMaxDuration),
	maxBackgroundOperations: Schema.optionalKey(Api.MaxBackgroundOperations),
	appReadRules: Api.AppReadRules,
	defaultRoles: Api.DefaultRoles,
	joinByDomain: Schema.Boolean,
	/** Missing in documents from before token rates. Then there is no limit. */
	tokenRate: Schema.optionalKey(Api.TokenRateLimits),
})
export type OrganizationDocument = typeof OrganizationDocument.Type

/** A new organization starts with these settings. */
export const organizationDefaults: OrganizationDocument = {
	rulesModel: null,
	botMemoryModel: null,
	botMemory: true,
	requestTimeoutMs: 24 * 60 * 60 * 1000,
	planApproval: PlanApproval.defaults,
	appReadRules: [],
	defaultRoles: ["member"],
	joinByDomain: true,
}

/** The settings of one member in one organization. */
export const MemberDocument = Schema.Struct({
	planApproval: Api.MemberSettings.fields.planApproval,
	/** Missing in documents from before default Bots. Then there is none. */
	defaultBot: Schema.optionalKey(Api.MemberSettings.fields.defaultBot),
})
export type MemberDocument = typeof MemberDocument.Type
export const memberDefaults: MemberDocument = {
	planApproval: null,
	defaultBot: null,
}

export type Scope =
	| { readonly kind: "platform" }
	| { readonly kind: "organization"; readonly id: string }
	/** `id` is the organization and the user, joined with a slash. */
	| { readonly kind: "member"; readonly id: string }
	/** Has no document. It says that SSO connections or domains changed. */
	| { readonly kind: "signIn" }

/** A scope with a stored document. */
export type DocumentScope = Exclude<Scope, { readonly kind: "signIn" }>

export const platformScope: DocumentScope = { kind: "platform" }
export const organizationScope = (id: string): DocumentScope => ({
	kind: "organization",
	id,
})
export const memberScope = (member: {
	readonly organizationId: string
	readonly userId: string
}) => ({
	kind: "member" as const,
	id: member.organizationId + "/" + member.userId,
})
/** The key of a scope in the table and in change notices. */
export const signInScope: Scope = { kind: "signIn" }
export const scopeKey = (scope: Scope) =>
	scope.kind === "organization" || scope.kind === "member"
		? scope.kind + ":" + scope.id
		: scope.kind + ":" + scope.kind
const ScopeKey = Schema.TemplateLiteralParser([
	Schema.Literals(["platform", "signIn", "organization", "member"]),
	":",
	Schema.NonEmptyString,
])
const decodeScopeKey = Schema.decodeUnknownOption(ScopeKey)
/** Reads the key that `scopeKey` makes. Any other text is none. */
export const parseScopeKey = (key: string): Option.Option<Scope> =>
	Option.map(decodeScopeKey(key), ([kind, , id]) =>
		kind === "platform"
			? platformScope
			: kind === "signIn"
				? signInScope
				: { kind, id },
	)

/** One version of a settings document. */
export interface Snapshot<Document> {
	readonly document: Document
	/** 0 means that nobody changed the settings yet, so they are the defaults. */
	readonly version: number
	readonly updatedAt: number
}
