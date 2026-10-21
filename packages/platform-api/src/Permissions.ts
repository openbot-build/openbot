import { Context, Schema } from "effect"
import { HttpApiMiddleware, HttpApiSchema } from "effect/http-api"
import { Identity } from "./Identity.ts"

/**
 * A permission group is a named set of actions on one kind of resource.
 * Policies grant or deny permission groups on resources.
 */
export const PermissionGroupId = Schema.Literals([
	"responses.run",
	"sessions.read",
	"sessions.write",
	"approvals.resolve",
	"connections.read",
	"connections.write",
	"apps.use",
	"apps.publish",
	"models.use",
	"tokens.read",
	"tokens.write",
	"organization.read",
	"organization.write",
	"members.read",
	"members.write",
	"audit_logs.read",
])
export type PermissionGroupId = typeof PermissionGroupId.Type

/** The kind of resource that a permission group acts on. */
export const ResourceKind = Schema.Literals([
	"organization",
	"user",
	"session",
	"connection",
	"apps",
	"model",
])
export type ResourceKind = typeof ResourceKind.Type

export const PermissionGroup = Schema.Struct({
	id: PermissionGroupId,
	name: Schema.String,
	scope: ResourceKind,
	description: Schema.String,
})
export type PermissionGroup = typeof PermissionGroup.Type

export const permissionGroups: ReadonlyArray<PermissionGroup> = [
	{
		id: "responses.run",
		name: "Responses Run",
		scope: "session",
		description: "Start, steer, queue and resume work in a Session.",
	},
	{
		id: "sessions.read",
		name: "Sessions Read",
		scope: "session",
		description: "Read Sessions, their history, memory and approvals.",
	},
	{
		id: "sessions.write",
		name: "Sessions Write",
		scope: "session",
		description:
			"Create, change, fork, restore, interrupt and delete Sessions.",
	},
	{
		id: "approvals.resolve",
		name: "Approvals Resolve",
		scope: "session",
		description: "Answer approvals for tool calls.",
	},
	{
		id: "connections.read",
		name: "Connections Read",
		scope: "connection",
		description: "Read App connections and App accounts.",
	},
	{
		id: "connections.write",
		name: "Connections Write",
		scope: "connection",
		description:
			"Create, change and delete App connections, and sign in to App accounts.",
	},
	{
		id: "apps.use",
		name: "Apps Use",
		scope: "apps",
		description: "Find Apps, and use App operations and App views.",
	},
	{
		id: "apps.publish",
		name: "Apps Publish",
		scope: "apps",
		description: "Use the developer tools for Apps that you publish.",
	},
	{
		id: "models.use",
		name: "Models Use",
		scope: "model",
		description: "Choose a model for a Session.",
	},
	{
		id: "tokens.read",
		name: "Tokens Read",
		scope: "user",
		description: "List API tokens.",
	},
	{
		id: "tokens.write",
		name: "Tokens Write",
		scope: "user",
		description: "Create and revoke API tokens.",
	},
	{
		id: "organization.read",
		name: "Organization Read",
		scope: "organization",
		description: "Read the organization settings.",
	},
	{
		id: "organization.write",
		name: "Organization Write",
		scope: "organization",
		description: "Change the organization settings.",
	},
	{
		id: "members.read",
		name: "Members Read",
		scope: "organization",
		description: "List members, their roles and their policies.",
	},
	{
		id: "members.write",
		name: "Members Write",
		scope: "organization",
		description:
			"Change the roles, policies and status of members, and remove members.",
	},
	{
		id: "audit_logs.read",
		name: "Audit Logs Read",
		scope: "organization",
		description: "Read the audit log.",
	},
]

/**
 * A resource key names one resource, such as
 * `openbot.org.<org>.user.<user>.session.<session>`.
 * A key covers itself and every key below it. Policies can use `{org}` for the
 * current organization and `{self}` for the user of the caller.
 */
export const ResourceKey = Schema.String.check(
	Schema.isMaxLength(512),
	Schema.isPattern(/^openbot\.org\.[^.\s]+(?:\.[^.\s]+)*$/),
)
export type ResourceKey = typeof ResourceKey.Type

export const Policy = Schema.Struct({
	effect: Schema.Literals(["allow", "deny"]),
	permissionGroups: Schema.Array(PermissionGroupId).check(
		Schema.isMinLength(1),
	),
	resources: Schema.Array(ResourceKey).check(Schema.isMinLength(1)),
})
export type Policy = typeof Policy.Type
export const Policies = Schema.Array(Policy).check(Schema.isMaxLength(50))

export const RoleId = Schema.Literals([
	"super_administrator",
	"administrator",
	"administrator_read_only",
	"member",
	"auditor",
])
export type RoleId = typeof RoleId.Type

export const Role = Schema.Struct({
	id: RoleId,
	name: Schema.String,
	description: Schema.String,
	policies: Schema.Array(Policy),
})
export type Role = typeof Role.Type

const organization = "openbot.org.{org}"
const self = "openbot.org.{org}.user.{self}"
const own: ReadonlyArray<PermissionGroupId> = [
	"responses.run",
	"sessions.read",
	"sessions.write",
	"approvals.resolve",
	"connections.read",
	"connections.write",
	"apps.use",
	"apps.publish",
	"tokens.read",
	"tokens.write",
]
const ownWork: Policy = {
	effect: "allow",
	permissionGroups: own,
	resources: [self],
}

/** Built-in roles. Their policies cannot change. */
export const roles: ReadonlyArray<Role> = [
	{
		id: "super_administrator",
		name: "Super Administrator",
		description:
			"Every permission in the organization. Only a Super Administrator can give or take away this role.",
		policies: [
			{
				effect: "allow",
				permissionGroups: PermissionGroupId.literals,
				resources: [organization],
			},
		],
	},
	{
		id: "administrator",
		name: "Administrator",
		description:
			"Manage the organization and its members. Work only with your own Sessions and connections.",
		policies: [
			ownWork,
			{
				effect: "allow",
				permissionGroups: [
					"models.use",
					"organization.read",
					"organization.write",
					"members.read",
					"members.write",
					"audit_logs.read",
				],
				resources: [organization],
			},
		],
	},
	{
		id: "administrator_read_only",
		name: "Administrator Read Only",
		description:
			"Read the organization, its members and the audit log. Work only with your own Sessions and connections.",
		policies: [
			ownWork,
			{
				effect: "allow",
				permissionGroups: [
					"models.use",
					"organization.read",
					"members.read",
					"audit_logs.read",
				],
				resources: [organization],
			},
		],
	},
	{
		id: "member",
		name: "Member",
		description:
			"Work with your own Sessions, connections and tokens, and use the models of the organization.",
		policies: [
			ownWork,
			{
				effect: "allow",
				permissionGroups: ["models.use", "organization.read"],
				resources: [organization],
			},
		],
	},
	{
		id: "auditor",
		name: "Auditor",
		description: "Read the organization, its members and the audit log.",
		policies: [
			{
				effect: "allow",
				permissionGroups: [
					"organization.read",
					"members.read",
					"audit_logs.read",
				],
				resources: [organization],
			},
		],
	},
]

export class PermissionDenied extends Schema.TaggedError<PermissionDenied>()(
	"PermissionDenied",
	{ permission: PermissionGroupId, resource: Schema.String },
) {}
/** Platform cannot read the roles and policies of the caller right now. */
export class AuthorizationUnavailable extends Schema.TaggedError<AuthorizationUnavailable>()(
	"AuthorizationUnavailable",
	{},
) {}
export const PermissionErrors = [
	PermissionDenied.pipe(HttpApiSchema.status(403)),
	AuthorizationUnavailable.pipe(HttpApiSchema.status(503)),
] as const

/**
 * Where the resource of a request is. The organization and the user come from the caller.
 * `param` names the path parameter with the ID of the resource.
 */
export interface ResourceRule {
	readonly kind: ResourceKind
	readonly param?: string
}
export interface Requirement {
	readonly permission: PermissionGroupId
	readonly resource: ResourceRule
}
/** The permissions that an endpoint needs. The `Authorize` middleware checks all of them. */
export class Required extends Context.Service<
	Required,
	ReadonlyArray<Requirement>
>()("@openbot-build/platform-api/Permissions/Required") {}
/**
 * The permissions for every endpoint of a group that has no `Required` annotation.
 * `read` is for GET requests. `write` is for every other method.
 */
export class GroupRequired extends Context.Service<
	GroupRequired,
	{
		readonly read: ReadonlyArray<Requirement>
		readonly write: ReadonlyArray<Requirement>
	}
>()("@openbot-build/platform-api/Permissions/GroupRequired") {}
/** Describe one permission that an endpoint needs. */
export const requires = (permission: PermissionGroupId) => ({
	on: (kind: ResourceKind, param?: string): Requirement => ({
		permission,
		resource: param === undefined ? { kind } : { kind, param },
	}),
})

/**
 * Checks the `Required` annotation of each endpoint, or the `GroupRequired`
 * annotation of its group, against the policies of the caller.
 * An endpoint without either annotation fails, so a new endpoint cannot be open by mistake.
 * @effect-expect-leaking RouteContext
 */
export class Authorize extends HttpApiMiddleware.Service<
	Authorize,
	{ readonly requires: Identity }
>()("@openbot-build/platform-api/Permissions/Authorize", {
	error: PermissionErrors,
}) {}
