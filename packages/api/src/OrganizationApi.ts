import { Schema } from "effect"
import {
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { Caller } from "./Identity.ts"
import { AccountAuth, NoStore } from "./AuthApi.ts"
import {
	CreateRoleRequest,
	PermissionErrors,
	PermissionGroup,
	Policies,
	Required,
	requires,
	Role,
	RoleId,
	UpdateRoleRequest,
} from "./Permissions.ts"
import {
	OrganizationSettings,
	SettingsErrors,
	UpdateOrganizationSettingsRequest,
} from "./Settings.ts"

/** A member always has at least one role. */
export const Roles = Schema.Array(RoleId).check(Schema.isMinLength(1))

export const OrganizationName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(120),
)
export const OrganizationStatus = Schema.Literals(["active", "suspended"])
export const Organization = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	/** A platform admin can suspend an organization. Then nobody can use it. */
	status: OrganizationStatus,
	createdAt: Schema.String,
})
export type Organization = typeof Organization.Type
export const UpdateOrganizationRequest = Schema.Struct({
	name: Schema.optionalKey(OrganizationName),
})
export type UpdateOrganizationRequest = typeof UpdateOrganizationRequest.Type
export const CreateOrganizationRequest = Schema.Struct({
	name: OrganizationName,
})
export type CreateOrganizationRequest = typeof CreateOrganizationRequest.Type

export const MemberStatus = Schema.Literals(["active", "suspended"])
export const Member = Schema.Struct({
	userId: Schema.String,
	email: Schema.NullOr(Schema.String),
	name: Schema.NullOr(Schema.String),
	status: MemberStatus,
	roles: Roles,
	/** Extra policies for this member, on top of the policies of the roles. */
	policies: Policies,
	joinedAt: Schema.String,
})
export type Member = typeof Member.Type
export const UpdateMemberRequest = Schema.Struct({
	status: Schema.optionalKey(MemberStatus),
	roles: Schema.optionalKey(Roles),
	policies: Schema.optionalKey(Policies),
})
export type UpdateMemberRequest = typeof UpdateMemberRequest.Type

/**
 * The audit actions of each resource. Each action id joins the resource and
 * the action with a dot, such as `token.created`.
 */
const auditActionTree = {
	member: ["joined", "updated", "removed"],
	organization: ["created", "updated"],
	settings: ["updated"],
	role: ["created", "updated", "deleted"],
	model: ["created", "updated", "deleted"],
	model_provider: ["created", "updated", "deleted"],
	domain: ["added", "verified", "removed"],
	sso_connection: ["created", "updated", "deleted"],
	token: ["created", "revoked"],
	agent: ["created", "updated", "promoted", "memory.updated"],
	delegation: ["started", "completed"],
	capability: ["decided"],
	request: ["resolved"],
	grant: ["created", "revoked"],
	rule: ["created", "updated"],
	trigger: ["created", "updated", "deleted", "hook_changed", "fired"],
} as const satisfies Record<string, ReadonlyArray<string>>
type AuditActionTree = typeof auditActionTree
/** The audit actions of one resource, such as `token.created`. */
export type AuditActionOf<Resource extends keyof AuditActionTree> =
	`${Resource}.${AuditActionTree[Resource][number]}`

export const AuditAction = Schema.Literals(
	Object.entries(auditActionTree).flatMap(([resource, actions]) =>
		actions.map(
			// `Object.entries` gives plain strings. The type above gives the same ids.
			(action) =>
				`${resource}.${action}` as AuditActionOf<keyof AuditActionTree>,
		),
	),
)
export type AuditAction = typeof AuditAction.Type
export const AuditLogEntry = Schema.Struct({
	id: Schema.String,
	createdAt: Schema.String,
	action: AuditAction,
	actor: Caller,
	resource: Schema.String,
	details: Schema.JsonObject,
})
export type AuditLogEntry = typeof AuditLogEntry.Type

const Limit = Schema.FiniteFromString.check(
	Schema.isBetween({ minimum: 1, maximum: 100 }),
)

export class MemberNotFound extends Schema.TaggedError<MemberNotFound>()(
	"MemberNotFound",
	{ userId: Schema.String },
) {}
/** An organization must keep at least one active Super Administrator. */
export class LastSuperAdministrator extends Schema.TaggedError<LastSuperAdministrator>()(
	"LastSuperAdministrator",
	{},
) {}
export class PolicyInvalid extends Schema.TaggedError<PolicyInvalid>()(
	"PolicyInvalid",
	{ message: Schema.String },
) {}
export class RoleNotFound extends Schema.TaggedError<RoleNotFound>()(
	"RoleNotFound",
	{ roleId: Schema.String },
) {}
/** Members or the settings still use the role. Give them another role first. */
export class RoleInUse extends Schema.TaggedError<RoleInUse>()("RoleInUse", {
	roleId: Schema.String,
}) {}
/** Built-in roles cannot change. */
export class RoleReadOnly extends Schema.TaggedError<RoleReadOnly>()(
	"RoleReadOnly",
	{ roleId: Schema.String },
) {}
/** Only platform admins can create organizations on this platform. */
export class OrganizationCreationDisabled extends Schema.TaggedError<OrganizationCreationDisabled>()(
	"OrganizationCreationDisabled",
	{},
) {}
export class OrganizationStorageUnavailable extends Schema.TaggedError<OrganizationStorageUnavailable>()(
	"OrganizationStorageUnavailable",
	{},
) {}
const errors = [
	OrganizationStorageUnavailable.pipe(HttpApiSchema.status(503)),
] as const
/** Changing a member can also need Super Administrator rights, so these endpoints can deny on their own. */
const memberErrors = [
	...errors,
	...PermissionErrors,
	MemberNotFound.pipe(HttpApiSchema.status(404)),
	LastSuperAdministrator.pipe(HttpApiSchema.status(409)),
	PolicyInvalid.pipe(HttpApiSchema.status(400)),
] as const

const readMembers = [requires("members.read").on("organization")]
const writeMembers = [requires("members.write").on("organization")]
const writeRoles = [requires("roles.write").on("organization")]
/** A role cannot give more than the person who writes it has, so these endpoints can deny on their own. */
const roleErrors = [
	...errors,
	...PermissionErrors,
	RoleNotFound.pipe(HttpApiSchema.status(404)),
	RoleInUse.pipe(HttpApiSchema.status(409)),
	RoleReadOnly.pipe(HttpApiSchema.status(409)),
	PolicyInvalid.pipe(HttpApiSchema.status(400)),
] as const

export const OrganizationApi = HttpApiGroup.make("organization").add(
	HttpApiEndpoint.get("getOrganization", "/v1/organization", {
		success: Organization,
		error: errors,
	}),
	HttpApiEndpoint.patch("updateOrganization", "/v1/organization", {
		payload: UpdateOrganizationRequest,
		success: Organization,
		error: [...errors, ...PermissionErrors],
	}),
	HttpApiEndpoint.get("listMembers", "/v1/organization/members", {
		query: {
			after: Schema.optionalKey(Schema.String),
			limit: Schema.optionalKey(Limit),
		},
		success: Schema.Struct({
			items: Schema.Array(Member),
			next: Schema.NullOr(Schema.String),
		}),
		error: errors,
	}).annotate(Required, readMembers),
	HttpApiEndpoint.get("getMember", "/v1/organization/members/:userId", {
		params: { userId: Schema.String },
		success: Member,
		error: memberErrors,
	}).annotate(Required, readMembers),
	HttpApiEndpoint.patch("updateMember", "/v1/organization/members/:userId", {
		params: { userId: Schema.String },
		payload: UpdateMemberRequest,
		success: Member,
		error: memberErrors,
	})
		.annotate(Required, writeMembers)
		.annotate(
			OpenApi.Description,
			"Changes the status, roles or extra policies of a member. A suspended member cannot sign in, and their tokens stop working.",
		),
	HttpApiEndpoint.delete("removeMember", "/v1/organization/members/:userId", {
		params: { userId: Schema.String },
		success: HttpApiSchema.NoContent,
		error: memberErrors,
	})
		.annotate(Required, writeMembers)
		.annotate(
			OpenApi.Description,
			"Removes a member and revokes their tokens. If their email domain is still allowed, they join again the next time they sign in. Suspend them to keep them out.",
		),
	HttpApiEndpoint.get(
		"listPermissionGroups",
		"/v1/organization/permission_groups",
		{ success: Schema.Array(PermissionGroup), error: errors },
	),
	HttpApiEndpoint.get("getSettings", "/v1/organization/settings", {
		success: OrganizationSettings,
		error: [...errors, ...SettingsErrors],
	}),
	HttpApiEndpoint.patch("updateSettings", "/v1/organization/settings", {
		payload: UpdateOrganizationSettingsRequest,
		success: OrganizationSettings,
		error: [...errors, ...SettingsErrors, ...PermissionErrors],
	}).annotate(
		OpenApi.Description,
		"Changes the settings. Send the `version` that you read as `expectedVersion`. If someone changed the settings since then, the change fails with SettingsConflict. Every instance uses the new settings right away.",
	),
	HttpApiEndpoint.get("listRoles", "/v1/organization/roles", {
		success: Schema.Array(Role),
		error: errors,
	}).annotate(
		OpenApi.Description,
		"Lists the built-in roles and the custom roles of the organization.",
	),
	HttpApiEndpoint.get("getRole", "/v1/organization/roles/:roleId", {
		params: { roleId: Schema.String },
		success: Role,
		error: roleErrors,
	}),
	HttpApiEndpoint.post("createRole", "/v1/organization/roles", {
		payload: CreateRoleRequest,
		success: Role,
		error: roleErrors,
	})
		.annotate(Required, writeRoles)
		.annotate(
			OpenApi.Description,
			"Creates a custom role. Its policies cannot allow anything that you cannot do yourself.",
		),
	HttpApiEndpoint.patch("updateRole", "/v1/organization/roles/:roleId", {
		params: { roleId: Schema.String },
		payload: UpdateRoleRequest,
		success: Role,
		error: roleErrors,
	})
		.annotate(Required, writeRoles)
		.annotate(
			OpenApi.Description,
			"Changes a custom role. Every member with the role gets the new policies at once.",
		),
	HttpApiEndpoint.delete("deleteRole", "/v1/organization/roles/:roleId", {
		params: { roleId: Schema.String },
		success: HttpApiSchema.NoContent,
		error: roleErrors,
	})
		.annotate(Required, writeRoles)
		.annotate(
			OpenApi.Description,
			"Deletes a custom role. It fails with RoleInUse while a member or the default roles use it.",
		),
	HttpApiEndpoint.get("listAuditLogs", "/v1/organization/audit_logs", {
		query: {
			after: Schema.optionalKey(Schema.String),
			limit: Schema.optionalKey(Limit),
			action: Schema.optionalKey(AuditAction),
			actor: Schema.optionalKey(Schema.String),
		},
		success: Schema.Struct({
			items: Schema.Array(AuditLogEntry),
			next: Schema.NullOr(Schema.String),
		}),
		error: errors,
	})
		.annotate(Required, [requires("audit_logs.read").on("organization")])
		.annotate(
			OpenApi.Description,
			"Lists audit log entries, newest first. `actor` filters by user ID.",
		),
)

/** The organizations of the caller. Any signed-in account can use these endpoints. */
export const OrganizationsApi = HttpApiGroup.make("organizations")
	.add(
		HttpApiEndpoint.get("listOrganizations", "/v1/organizations", {
			success: Schema.Struct({ items: Schema.Array(Organization) }),
			error: errors,
		}).annotate(
			OpenApi.Description,
			"Lists the organizations where you are a member. A user token sees only its own organization.",
		),
		HttpApiEndpoint.post("createOrganization", "/v1/organizations", {
			payload: CreateOrganizationRequest,
			success: Organization,
			error: [
				...errors,
				OrganizationCreationDisabled.pipe(HttpApiSchema.status(403)),
			],
		}).annotate(
			OpenApi.Description,
			"Creates an organization. You become its Super Administrator. The platform settings say who can do this.",
		),
	)
	.middleware(AccountAuth)
	.middleware(NoStore)
