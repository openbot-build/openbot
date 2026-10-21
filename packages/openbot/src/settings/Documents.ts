import { Settings as Api } from "@openbot-build/api"
import { Schema } from "effect"

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
	policyCeiling: Api.CeilingPolicies,
	appRestrictions: Api.PlatformSettings.fields.appRestrictions,
})
export type PlatformDocument = typeof PlatformDocument.Type

export const OrganizationDocument = Schema.Struct({
	defaultModel: Api.OrganizationSettings.fields.defaultModel,
	helperModel: Api.OrganizationSettings.fields.helperModel,
	memory: Api.OrganizationSettings.fields.memory,
	agentMemory: Schema.Boolean,
	requestTimeoutMs: Api.RequestTimeout,
	appReadRules: Api.AppReadRules,
	defaultRoles: Api.DefaultRoles,
	joinByDomain: Schema.Boolean,
})
export type OrganizationDocument = typeof OrganizationDocument.Type

/** A new organization starts with these settings. */
export const organizationDefaults: OrganizationDocument = {
	defaultModel: null,
	helperModel: null,
	memory: { use: true, generate: true },
	agentMemory: true,
	requestTimeoutMs: 24 * 60 * 60 * 1000,
	appReadRules: [],
	defaultRoles: ["member"],
	joinByDomain: true,
}

export type Scope =
	| { readonly kind: "platform" }
	| { readonly kind: "organization"; readonly id: string }
	/** Has no document. It says that SSO connections or domains changed. */
	| { readonly kind: "signIn" }

/** A scope with a stored document. */
export type DocumentScope = Exclude<Scope, { readonly kind: "signIn" }>

export const platformScope: DocumentScope = { kind: "platform" }
export const organizationScope = (id: string): DocumentScope => ({
	kind: "organization",
	id,
})
/** The key of a scope in the table and in change notices. */
export const signInScope: Scope = { kind: "signIn" }
export const scopeKey = (scope: Scope) =>
	scope.kind === "organization"
		? "organization:" + scope.id
		: scope.kind + ":" + scope.kind
export const parseScopeKey = (key: string): Scope | undefined => {
	const colon = key.indexOf(":")
	const kind = key.slice(0, colon)
	const id = key.slice(colon + 1)
	if (colon < 0 || id === "") return undefined
	if (kind === "platform") return platformScope
	if (kind === "signIn") return signInScope
	if (kind === "organization") return organizationScope(id)
	return undefined
}

/** One version of a settings document. */
export interface Snapshot<Document> {
	readonly document: Document
	/** 0 means that nobody changed the settings yet, so they are the defaults. */
	readonly version: number
	readonly updatedAt: number
}
