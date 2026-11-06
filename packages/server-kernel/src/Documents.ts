import * as Access from "@openbot-build/domain/Access"
import { Settings as SettingsModel } from "@openbot-build/domain"
import { Authorization, PlanApproval } from "@openbot-build/domain"
import { Option, Schema } from "effect"

/** The stored form of the file settings. The secret key is sealed. */
export const FilesDocument = Schema.Struct({
	storage: Schema.NullOr(
		Schema.Struct({
			endpoint: SettingsModel.FileStorage.fields.endpoint,
			publicEndpoint: SettingsModel.FileStorage.fields.publicEndpoint,
			region: SettingsModel.FileStorage.fields.region,
			bucket: SettingsModel.FileStorage.fields.bucket,
			accessKeyId: SettingsModel.FileStorage.fields.accessKeyId,
			forcePathStyle: SettingsModel.FileStorage.fields.forcePathStyle,
			secretAccessKey: Schema.String,
			secretAccessKeyHint: Schema.NullOr(Schema.String),
		}),
	),
	uploads: SettingsModel.Files.fields.uploads,
	maxBytes: SettingsModel.Files.fields.maxBytes,
	quotaBytes: SettingsModel.Files.fields.quotaBytes,
	mediaTypes: SettingsModel.Files.fields.mediaTypes,
	unusedMs: SettingsModel.Files.fields.unusedMs,
})
export type FilesDocument = typeof FilesDocument.Type

/** The SMTP settings. The password is sealed, or null without a login. */
export const MailDocument = Schema.Struct({
	...SettingsModel.Mail.fields,
	password: Schema.NullOr(Schema.String),
})
export type MailDocument = typeof MailDocument.Type

/**
 * The stored form of the platform settings. Secrets are sealed with the
 * secret keys of the instance, and only this code opens them.
 */
export const PlatformDocument = Schema.Struct({
	publicOrigin: SettingsModel.PublicOrigin,
	/** Signs the sign-in cookies of Better Auth. `openbot setup` makes it. */
	authSecret: Schema.String,
	/** Null means that people sign in only through the SSO connections of organizations. */
	identityProvider: Schema.NullOr(
		Schema.Struct({
			issuer: SettingsModel.Issuer,
			clientId: SettingsModel.ClientId,
			clientSecret: Schema.NullOr(Schema.String),
			clientSecretHint: Schema.NullOr(Schema.String),
		}),
	),
	organizationCreation: SettingsModel.OrganizationCreation,
	registration: Access.Registration,
	ceiling: SettingsModel.PlatformSettings.fields.ceiling,
	appRestrictions: SettingsModel.PlatformSettings.fields.appRestrictions,
	codeMode: SettingsModel.CodeMode,
	rateLimit: SettingsModel.RateLimit,
	tokenRate: SettingsModel.TokenRateLimits,
	files: FilesDocument,
	/** Null means that no mail is sent. */
	mail: Schema.NullOr(MailDocument),
})
export type PlatformDocument = typeof PlatformDocument.Type

/** No storage, so nobody can upload files yet. */
export const filesDefaults: FilesDocument = {
	...SettingsModel.fileDefaults,
	storage: null,
}

/**
 * The settings that a new platform document starts with, next to its origin,
 * its sign-in secret and its identity provider.
 */
export const platformDefaults: Omit<
	PlatformDocument,
	"publicOrigin" | "authSecret" | "identityProvider"
> = {
	organizationCreation: "platform_admins",
	registration: Access.defaults,
	ceiling: Authorization.emptyPolicy,
	appRestrictions: [],
	codeMode: SettingsModel.codeModeDefaults,
	rateLimit: SettingsModel.rateLimitDefaults,
	tokenRate: SettingsModel.tokenRateDefaults,
	files: filesDefaults,
	mail: null,
}

export const OrganizationDocument = Schema.Struct({
	rulesModel: SettingsModel.OrganizationSettings.fields.rulesModel,
	botMemoryModel: SettingsModel.OrganizationSettings.fields.botMemoryModel,
	botMemory: Schema.Boolean,
	requestTimeoutMs: SettingsModel.RequestTimeout,
	delegationTimeLimitMs: SettingsModel.DelegationTimeLimit,
	planApproval: PlanApproval.PlanApproval,
	toolForegroundBudgetMs: SettingsModel.ToolForegroundBudget,
	toolMaxDurationMs: SettingsModel.ToolMaxDuration,
	maxBackgroundOperations: SettingsModel.MaxBackgroundOperations,
	appReadRules: SettingsModel.AppReadRules,
	defaultRoles: SettingsModel.DefaultRoles,
	joinByDomain: Schema.Boolean,
	tokenRate: SettingsModel.TokenRateLimits,
})
export type OrganizationDocument = typeof OrganizationDocument.Type

/** A new organization starts with these settings. */
export const organizationDefaults: OrganizationDocument = {
	rulesModel: null,
	botMemoryModel: null,
	botMemory: true,
	requestTimeoutMs: 24 * 60 * 60 * 1000,
	delegationTimeLimitMs: SettingsModel.delegationTimeLimitDefault,
	planApproval: PlanApproval.defaults,
	toolForegroundBudgetMs: SettingsModel.toolForegroundBudgetDefault,
	toolMaxDurationMs: SettingsModel.toolMaxDurationDefault,
	maxBackgroundOperations: SettingsModel.maxBackgroundOperationsDefault,
	appReadRules: [],
	defaultRoles: ["member"],
	joinByDomain: true,
	tokenRate: SettingsModel.tokenRateDefaults,
}

/** The settings of one member in one organization. */
export const MemberDocument = Schema.Struct({
	planApproval: SettingsModel.MemberSettings.fields.planApproval,
	defaultBot: SettingsModel.MemberSettings.fields.defaultBot,
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
