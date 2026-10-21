import { Context, Schema } from "effect"
import { HttpApiMiddleware, HttpApiSchema } from "effect/http-api"
import { Identity } from "./Identity.ts"

/** The kind of resource that a permission group acts on. */
export const ResourceKind = Schema.Literals([
	"platform",
	"organization",
	"user",
	"session",
	"agent",
	"request",
	"connection",
	"apps",
	"model",
])
export type ResourceKind = typeof ResourceKind.Type

/**
 * A permission group is a named set of actions on one kind of resource.
 * Policies grant or deny permission groups on resources.
 * This tree is the only source of permission groups. Each id joins a resource
 * and an action with a dot, such as `sessions.read`.
 */
const permissionTree = {
	responses: {
		scope: "session",
		actions: {
			run: {
				name: "Responses Run",
				description: "Start, steer, queue and resume work in a Session.",
			},
		},
	},
	sessions: {
		scope: "session",
		actions: {
			read: {
				name: "Sessions Read",
				description: "Read Sessions, their history, memory and delegations.",
			},
			write: {
				name: "Sessions Write",
				description:
					"Create, change, fork, restore, interrupt and delete Sessions.",
			},
		},
	},
	requests: {
		scope: "request",
		actions: {
			resolve: {
				name: "Requests Resolve",
				description:
					"Answer the requests of your Agents for new capabilities, such as App tool calls.",
			},
		},
	},
	agents: {
		scope: "agent",
		actions: {
			read: {
				name: "Agents Read",
				description: "Read Agents, their memory, Rules and Grants.",
			},
			write: {
				name: "Agents Write",
				description:
					"Create and change Agents, their memory, Rules and Grants.",
			},
			delegate: {
				name: "Agents Delegate",
				description:
					"Give work to an Agent, from a client or from another Agent.",
			},
		},
	},
	connections: {
		scope: "connection",
		actions: {
			read: {
				name: "Connections Read",
				description: "Read App connections and App accounts.",
			},
			write: {
				name: "Connections Write",
				description:
					"Create, change and delete App connections, and sign in to App accounts.",
			},
		},
	},
	apps: {
		scope: "apps",
		actions: {
			use: {
				name: "Apps Use",
				description: "Find Apps, and use App operations and App views.",
			},
			publish: {
				name: "Apps Publish",
				description: "Use the developer tools for Apps that you publish.",
			},
		},
	},
	models: {
		scope: "model",
		actions: {
			use: {
				name: "Models Use",
				description: "Choose a model for a Session.",
			},
		},
	},
	tokens: {
		scope: "user",
		actions: {
			read: {
				name: "Tokens Read",
				description: "List API tokens.",
			},
			write: {
				name: "Tokens Write",
				description: "Create and revoke API tokens.",
			},
		},
	},
	organization: {
		scope: "organization",
		actions: {
			read: {
				name: "Organization Read",
				description: "Read the name and settings of the organization.",
			},
			write: {
				name: "Organization Write",
				description: "Change the name and settings of the organization.",
			},
		},
	},
	roles: {
		scope: "organization",
		actions: {
			write: {
				name: "Roles Write",
				description:
					"Create, change and delete the custom roles of the organization.",
			},
		},
	},
	model_providers: {
		scope: "organization",
		actions: {
			read: {
				name: "Model Providers Read",
				description:
					"Read the model providers of the organization. Keys are never shown.",
			},
			write: {
				name: "Model Providers Write",
				description:
					"Add, change and remove the model providers and keys of the organization.",
			},
		},
	},
	sso: {
		scope: "organization",
		actions: {
			read: {
				name: "SSO Read",
				description: "Read the email domains and SSO connections.",
			},
			write: {
				name: "SSO Write",
				description:
					"Add and verify email domains, and change SSO connections.",
			},
		},
	},
	platform: {
		scope: "platform",
		actions: {
			read: {
				name: "Platform Read",
				description:
					"Read the platform settings, organizations, admins and shared model providers. Only platform admins can use it.",
			},
			write: {
				name: "Platform Write",
				description:
					"Change the platform settings, organizations, admins and shared model providers. Only platform admins can use it.",
			},
		},
	},
	members: {
		scope: "organization",
		actions: {
			read: {
				name: "Members Read",
				description: "List members, their roles and their policies.",
			},
			write: {
				name: "Members Write",
				description:
					"Change the roles, policies and status of members, and remove members.",
			},
		},
	},
	audit_logs: {
		scope: "organization",
		actions: {
			read: {
				name: "Audit Logs Read",
				description: "Read the audit log.",
			},
		},
	},
} as const satisfies Record<
	string,
	{
		readonly scope: ResourceKind
		readonly actions: Record<
			string,
			{ readonly name: string; readonly description: string }
		>
	}
>
type PermissionTree = typeof permissionTree

type PermissionGroupIds = {
	readonly [
		Resource in keyof PermissionTree
	]: `${Resource}.${keyof PermissionTree[Resource]["actions"] & string}`
}[keyof PermissionTree]

const permissionGroupList = Object.entries(permissionTree).flatMap(
	([resource, { scope, actions }]) =>
		Object.entries(actions).map(([action, group]) => ({
			// `Object.entries` gives plain strings. The type above gives the same ids.
			id: `${resource}.${action}` as PermissionGroupIds,
			name: group.name,
			scope,
			description: group.description,
		})),
)

export const PermissionGroupId = Schema.Literals(
	permissionGroupList.map((group) => group.id),
)
export type PermissionGroupId = typeof PermissionGroupId.Type

/** The first part of a permission group id, such as `sessions`. */
export type PermissionResource = keyof PermissionTree
/** The permission groups of one resource, such as `tokens.read` and `tokens.write`. */
export const permissionGroupsOf = (
	resource: PermissionResource,
): ReadonlyArray<PermissionGroupId> =>
	permissionGroupList
		.filter((group) => group.id.startsWith(resource + "."))
		.map((group) => group.id)

export const PermissionGroup = Schema.Struct({
	id: PermissionGroupId,
	name: Schema.String,
	scope: ResourceKind,
	description: Schema.String,
})
export type PermissionGroup = typeof PermissionGroup.Type

export const permissionGroups: ReadonlyArray<PermissionGroup> =
	permissionGroupList
/**
 * A resource key names one resource, such as
 * `openbot.org.<org>.user.<user>.session.<session>`.
 * A key covers itself and every key below it. Policies can use `{org}` for the
 * current organization and `{self}` for the user of the caller.
 * `openbot.platform` is the whole deployment. Only the policies of tokens can name it.
 */
export const ResourceKey = Schema.String.check(
	Schema.isMaxLength(512),
	Schema.isPattern(
		/^(?:openbot\.platform|openbot\.org\.[^.\s]+(?:\.[^.\s]+)*)$/,
	),
)
export type ResourceKey = typeof ResourceKey.Type

/** Whether a decision allows or denies something. */
export const Decision = Schema.Literals(["allow", "deny"])
export type Decision = typeof Decision.Type

export const Policy = Schema.Struct({
	effect: Decision,
	permissionGroups: Schema.Array(PermissionGroupId).check(
		Schema.isMinLength(1),
	),
	resources: Schema.Array(ResourceKey).check(Schema.isMinLength(1)),
})
export type Policy = typeof Policy.Type
export const Policies = Schema.Array(Policy).check(Schema.isMaxLength(50))

/** The resource key of the whole deployment. */
export const platformResource = "openbot.platform"
/** The resource pattern of the current organization. */
export const organizationResource = "openbot.org.{org}"
/** The resource pattern of the user of the caller. */
export const selfResource = "openbot.org.{org}.user.{self}"
const organization = organizationResource
const self = selfResource
/** The shared Agents of the organization. */
const sharedAgents = "openbot.org.{org}.agent"
const own: ReadonlyArray<PermissionGroupId> = [
	"responses.run",
	"sessions.read",
	"sessions.write",
	"requests.resolve",
	"agents.read",
	"agents.write",
	"agents.delegate",
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
const useSharedAgents: Policy = {
	effect: "allow",
	permissionGroups: ["agents.read", "agents.delegate"],
	resources: [sharedAgents],
}

/**
 * Built-in roles. Every organization has them, and their policies cannot change.
 * An organization can add custom roles. Their IDs start with `role_`.
 */
export const builtinRoles = [
	{
		id: "super_administrator",
		name: "Super Administrator",
		description:
			"Every permission in the organization. Only a Super Administrator can give or take away this role.",
		policies: [
			{
				effect: "allow",
				permissionGroups: PermissionGroupId.literals.filter(
					(id) => !id.startsWith("platform."),
				),
				resources: [organization],
			},
		],
	},
	{
		id: "administrator",
		name: "Administrator",
		description:
			"Manage the organization, its members and its shared Agents. Work only with your own Sessions and connections.",
		policies: [
			ownWork,
			useSharedAgents,
			{
				effect: "allow",
				permissionGroups: ["agents.write"],
				resources: [sharedAgents],
			},
			{
				effect: "allow",
				permissionGroups: [
					"models.use",
					"organization.read",
					"organization.write",
					"members.read",
					"members.write",
					"roles.write",
					"model_providers.read",
					"model_providers.write",
					"sso.read",
					"sso.write",
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
			useSharedAgents,
			{
				effect: "allow",
				permissionGroups: [
					"models.use",
					"organization.read",
					"members.read",
					"model_providers.read",
					"sso.read",
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
			"Work with your own Agents, Sessions, connections and tokens, and use the shared Agents and the models of the organization.",
		policies: [
			ownWork,
			useSharedAgents,
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
] as const satisfies ReadonlyArray<{
	readonly id: string
	readonly name: string
	readonly description: string
	readonly policies: ReadonlyArray<Policy>
}>

export const BuiltinRoleId = Schema.Literals(
	builtinRoles.map((role) => role.id),
)
export type BuiltinRoleId = typeof BuiltinRoleId.Type
/** The ID of a custom role. */
export const CustomRoleId = Schema.String.check(
	Schema.isPattern(/^role_[a-z0-9]{32}$/),
)
export const RoleId = Schema.Union([BuiltinRoleId, CustomRoleId])
export type RoleId = typeof RoleId.Type
export const isBuiltinRole = Schema.is(BuiltinRoleId)

export const RoleName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(120),
)
export const Role = Schema.Struct({
	id: RoleId,
	name: Schema.String,
	description: Schema.String,
	builtin: Schema.Boolean,
	policies: Schema.Array(Policy),
})
export type Role = typeof Role.Type
export const CreateRoleRequest = Schema.Struct({
	name: RoleName,
	description: Schema.String.check(Schema.isMaxLength(1000)),
	policies: Policies,
})
export type CreateRoleRequest = typeof CreateRoleRequest.Type
export const UpdateRoleRequest = Schema.Struct({
	name: Schema.optionalKey(RoleName),
	description: Schema.optionalKey(
		Schema.String.check(Schema.isMaxLength(1000)),
	),
	policies: Schema.optionalKey(Policies),
})
export type UpdateRoleRequest = typeof UpdateRoleRequest.Type

export class PermissionDenied extends Schema.TaggedError<PermissionDenied>()(
	"PermissionDenied",
	{ permission: PermissionGroupId, resource: Schema.String },
) {}
/** OpenBot cannot read the roles and policies of the caller right now. */
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
>()("@openbot-build/api/Permissions/Required") {}
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
>()("@openbot-build/api/Permissions/GroupRequired") {}
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
>()("@openbot-build/api/Permissions/Authorize", {
	error: PermissionErrors,
}) {}
