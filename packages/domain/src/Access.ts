import { Schema } from "effect"
import { Email } from "./Email.ts"
import { RoleId } from "./Roles.ts"

export const AdmissionMode = Schema.Literals(["closed", "allow", "approval"])
export const GroupMapping = Schema.Struct({
	group: Schema.NonEmptyString.check(Schema.isMaxLength(255)),
	organizationId: Schema.NonEmptyString,
	roles: Schema.Array(RoleId).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(50),
	),
})
export const ProviderAccess = Schema.Struct({
	trusted: Schema.Boolean,
	scopes: Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(20)),
	groupsClaim: Schema.NullOr(Schema.NonEmptyString),
	requiredGroups: Schema.Array(Schema.NonEmptyString).check(
		Schema.isMaxLength(100),
	),
	mappings: Schema.Array(GroupMapping).check(Schema.isMaxLength(100)),
})
export type ProviderAccess = typeof ProviderAccess.Type
export const providerDefaults: ProviderAccess = {
	trusted: false,
	scopes: [],
	groupsClaim: null,
	requiredGroups: [],
	mappings: [],
}
export const Registration = Schema.Struct({
	selfService: AdmissionMode,
	emailSignIn: Schema.Boolean,
	invitations: AdmissionMode,
	sso: AdmissionMode,
	trustedSsoProviders: Schema.Array(Schema.NonEmptyString).check(
		Schema.isMaxLength(100),
	),
	allowedEmailDomains: Schema.Array(
		Schema.String.check(Schema.isPattern(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/)),
	).check(Schema.isMaxLength(100)),
	allowExternalInvitations: Schema.Boolean,
	provider: ProviderAccess,
})
export type Registration = typeof Registration.Type
export const defaults: Registration = {
	selfService: "closed",
	emailSignIn: false,
	invitations: "allow",
	sso: "closed",
	trustedSsoProviders: [],
	allowedEmailDomains: [],
	allowExternalInvitations: false,
	provider: providerDefaults,
}
export const AccountStatus = Schema.Literals(["active", "suspended"])
export const User = Schema.Struct({
	id: Schema.String,
	email: Schema.String,
	name: Schema.String,
	status: AccountStatus,
	createdAt: Schema.String,
})
export const Request = Schema.Struct({
	id: Schema.String,
	providerId: Schema.String,
	email: Schema.String,
	source: Schema.Literals(["selfService", "invitations", "sso"]),
	status: Schema.Literals(["pending", "approved", "rejected"]),
	version: Schema.Int,
	createdAt: Schema.Finite,
})
export const Grant = Schema.Struct({
	email: Email,
	providerId: Schema.String,
	createdAt: Schema.Finite,
})
export const Event = Schema.Struct({
	id: Schema.String,
	action: Schema.String,
	actor: Schema.String,
	subject: Schema.String,
	createdAt: Schema.Finite,
})
export const LoginOptions = Schema.Struct({
	emailSignIn: Schema.Boolean,
	oidc: Schema.Boolean,
	selfService: AdmissionMode,
	invitations: AdmissionMode,
})
export class AccessDenied extends Schema.TaggedError<
	AccessDenied,
	{ readonly brand: unique symbol }
>()("AccessDenied", {
	reason: Schema.Literals([
		"closed",
		"pending",
		"rejected",
		"invitation",
		"domain",
		"identity",
		"suspended",
		"groups",
		"rate_limited",
	]),
}) {}
export class AccessConflict extends Schema.TaggedError<
	AccessConflict,
	{ readonly brand: unique symbol }
>()("AccessConflict", { message: Schema.String }) {}
export class AccessUnavailable extends Schema.TaggedError<
	AccessUnavailable,
	{ readonly brand: unique symbol }
>()("AccessUnavailable", {}) {}
