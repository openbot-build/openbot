import { Context, Schema } from "effect"
import { HttpApiMiddleware, HttpApiSchema } from "effect/http-api"
import { Identity } from "./Identity.ts"

/** The kind of resource that a permission group acts on. */
export const ResourceKind = Schema.Literals([
	"platform",
	"organization",
	"user",
	"chat",
	"file",
	"bot",
	"trigger",
	"channel",
	"request",
	"connection",
	"apps",
	"model",
	"computer",
	"computer_provider",
])
export type ResourceKind = typeof ResourceKind.Type

/**
 * A permission group is a named set of actions on one kind of resource.
 * Policies grant or deny permission groups on resources.
 * This tree is the only source of permission groups. Each id joins a resource
 * and an action with a dot, such as `chats.read`.
 */
const permissionTree = {
	responses: {
		scope: "chat",
		actions: {
			run: {
				name: "Responses Run",
				description: "Send messages to Bots, so that they work in a Chat.",
			},
		},
	},
	chats: {
		scope: "chat",
		actions: {
			read: {
				name: "Chats Read",
				description:
					"Read Chats, their history and the work that they gave away.",
			},
			write: {
				name: "Chats Write",
				description:
					"Change, interrupt and delete Chats, and cancel the work that they gave away.",
			},
		},
	},
	files: {
		scope: "file",
		actions: {
			read: {
				name: "Files Read",
				description: "Read your files and their bytes.",
			},
			write: {
				name: "Files Write",
				description: "Upload and delete your files.",
			},
		},
	},
	requests: {
		scope: "request",
		actions: {
			resolve: {
				name: "Requests Resolve",
				description:
					"Answer the requests of your Bots for new capabilities, such as App tool calls.",
			},
		},
	},
	bots: {
		scope: "bot",
		actions: {
			read: {
				name: "Bots Read",
				description: "Read Bots, their memory, Rules and Grants.",
			},
			write: {
				name: "Bots Write",
				description: "Create and change Bots, their memory, Rules and Grants.",
			},
			delegate: {
				name: "Bots Delegate",
				description: "Give work to a Bot, from a client or from another Bot.",
			},
			share: {
				name: "Bots Share",
				description:
					"Invite other people to use a Bot, and manage the people who use it.",
			},
		},
	},
	triggers: {
		scope: "trigger",
		actions: {
			read: {
				name: "Triggers Read",
				description: "Read triggers: their schedules and webhooks.",
			},
			write: {
				name: "Triggers Write",
				description:
					"Create, change and delete triggers, and set their webhook secrets.",
			},
		},
	},
	channels: {
		scope: "channel",
		actions: {
			read: {
				name: "Channels Read",
				description:
					"Read the Channels of the organization and the people linked to them.",
			},
			write: {
				name: "Channels Write",
				description:
					"Create, change and delete Channels, set their secrets, and unlink people.",
			},
			use: {
				name: "Channels Use",
				description:
					"Talk with the Bot of a Channel, and let your Bots post to it.",
			},
		},
	},
	channel_identities: {
		scope: "user",
		actions: {
			read: {
				name: "Channel Identities Read",
				description: "Read your linked accounts on the platforms of Channels.",
			},
			write: {
				name: "Channel Identities Write",
				description:
					"Link and unlink your accounts on the platforms of Channels.",
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
	computers: {
		scope: "computer",
		actions: {
			read: {
				name: "Computers Read",
				description:
					"Read Computers, the Bots that may use them, and their usage.",
			},
			write: {
				name: "Computers Write",
				description:
					"Create, change and delete Computers, pair machines, and make connector tokens.",
			},
			use: {
				name: "Computers Use",
				description:
					"Run commands, change files, open ports and use the desktop of Computers, and let your Bots use them.",
			},
		},
	},
	computer_providers: {
		scope: "computer_provider",
		actions: {
			read: {
				name: "Computer Providers Read",
				description: "Read the accounts at Computer providers.",
			},
			write: {
				name: "Computer Providers Write",
				description:
					"Add, change and delete accounts at Computer providers, and their keys.",
			},
			use: {
				name: "Computer Providers Use",
				description: "Create Computers with an account at a Computer provider.",
			},
		},
	},
	models: {
		scope: "model",
		actions: {
			use: {
				name: "Models Use",
				description: "Choose a model for a Chat.",
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
	usage: {
		scope: "organization",
		actions: {
			read: {
				name: "Usage Read",
				description:
					"Read the model usage and its cost, and the credits of the organization.",
			},
		},
	},
	budgets: {
		scope: "organization",
		actions: {
			read: {
				name: "Budgets Read",
				description: "Read the budgets and how much of them is spent.",
			},
			write: {
				name: "Budgets Write",
				description: "Create, change and delete budgets.",
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

/** The first part of a permission group id, such as `chats`. */
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
 * `openbot.org.<org>.user.<user>.chat.<chat>`.
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
/** The shared Bots of the organization. */
const sharedBots = "openbot.org.{org}.bot"
/** The shared triggers of the organization. */
const sharedTriggers = "openbot.org.{org}.trigger"
/** The Channels of the organization. */
const channels = "openbot.org.{org}.channel"
/** The shared Computers of the organization. */
const sharedComputers = "openbot.org.{org}.computer"
/** The shared Computer providers of the organization. */
const sharedComputerProviders = "openbot.org.{org}.computer_provider"
const own: ReadonlyArray<PermissionGroupId> = [
	"responses.run",
	"chats.read",
	"chats.write",
	"files.read",
	"files.write",
	"requests.resolve",
	"bots.read",
	"bots.write",
	"bots.delegate",
	"bots.share",
	"triggers.read",
	"triggers.write",
	"channel_identities.read",
	"channel_identities.write",
	"connections.read",
	"connections.write",
	"computers.read",
	"computers.write",
	"computers.use",
	"computer_providers.read",
	"computer_providers.write",
	"computer_providers.use",
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
const useSharedBots: Policy = {
	effect: "allow",
	permissionGroups: ["bots.read", "bots.delegate"],
	resources: [sharedBots],
}
const readSharedTriggers: Policy = {
	effect: "allow",
	permissionGroups: ["triggers.read"],
	resources: [sharedTriggers],
}
const useChannels: Policy = {
	effect: "allow",
	permissionGroups: ["channels.use"],
	resources: [channels],
}
const useSharedComputers: Policy = {
	effect: "allow",
	permissionGroups: [
		"computers.read",
		"computers.use",
		"computer_providers.read",
		"computer_providers.use",
	],
	resources: [sharedComputers, sharedComputerProviders],
}
const readSharedComputers: Policy = {
	effect: "allow",
	permissionGroups: ["computers.read", "computer_providers.read"],
	resources: [sharedComputers, sharedComputerProviders],
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
			"Manage the organization, its members, its shared Bots, its shared triggers, its shared Computers and its Channels. Work only with your own Chats and connections.",
		policies: [
			ownWork,
			useSharedBots,
			readSharedTriggers,
			useChannels,
			useSharedComputers,
			{
				effect: "allow",
				permissionGroups: ["bots.write", "bots.share"],
				resources: [sharedBots],
			},
			{
				effect: "allow",
				permissionGroups: ["computers.write", "computer_providers.write"],
				resources: [sharedComputers, sharedComputerProviders],
			},
			{
				effect: "allow",
				permissionGroups: ["triggers.write"],
				resources: [sharedTriggers],
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
					"channels.read",
					"channels.write",
					"audit_logs.read",
					"usage.read",
					"budgets.read",
					"budgets.write",
				],
				resources: [organization],
			},
		],
	},
	{
		id: "administrator_read_only",
		name: "Administrator Read Only",
		description:
			"Read the organization, its members, usage, budgets and the audit log. Work only with your own Chats and connections.",
		policies: [
			ownWork,
			useSharedBots,
			readSharedTriggers,
			useChannels,
			readSharedComputers,
			{
				effect: "allow",
				permissionGroups: [
					"models.use",
					"organization.read",
					"members.read",
					"model_providers.read",
					"sso.read",
					"channels.read",
					"audit_logs.read",
					"usage.read",
					"budgets.read",
				],
				resources: [organization],
			},
		],
	},
	{
		id: "member",
		name: "Member",
		description:
			"Work with your own Bots, Chats, triggers, Computers, connections and tokens, and use the shared Bots, triggers, Computers, Channels and models of the organization.",
		policies: [
			ownWork,
			useSharedBots,
			readSharedTriggers,
			useChannels,
			useSharedComputers,
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
		description:
			"Read the organization, its members, usage, budgets and the audit log.",
		policies: [
			{
				effect: "allow",
				permissionGroups: [
					"organization.read",
					"members.read",
					"audit_logs.read",
					"usage.read",
					"budgets.read",
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
