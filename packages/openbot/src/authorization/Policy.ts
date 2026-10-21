import {
	type AgentsApi,
	Permissions,
	type WorkflowsApi,
} from "@openbot-build/api"
import { Option } from "effect"

type PermissionGroupId = Permissions.PermissionGroupId
type Policy = Permissions.Policy

/** IDs go into dotted keys, so a dot in an ID must not look like a new part. */
export const segment = (id: string) =>
	encodeURIComponent(id).replaceAll(".", "%2E")

export interface Subject {
	readonly organizationId: string
	readonly userId: string
}

export const organizationKey = (organizationId: string) =>
	"openbot.org." + segment(organizationId)
export const userKey = (subject: Subject) =>
	organizationKey(subject.organizationId) + ".user." + segment(subject.userId)

/** The key of one resource, or of the place for resources of that kind when there is no ID. */
export const resourceKey = (target: {
	readonly subject: Subject
	readonly kind: Permissions.ResourceKind
	readonly id: Option.Option<string>
}): string => {
	const { subject, kind, id } = target
	// The kind is the name of its key part, such as `session`.
	const child = (parent: string) =>
		Option.match(id, {
			onNone: () => parent + "." + kind,
			onSome: (id) => parent + "." + kind + "." + segment(id),
		})
	switch (kind) {
		case "platform":
			return Permissions.platformResource
		case "organization":
			return organizationKey(subject.organizationId)
		case "user":
			return userKey(subject)
		case "apps":
			return userKey(subject) + "." + kind
		case "session":
		case "connection":
		case "request":
			return child(userKey(subject))
		// The key of one Agent or Workflow depends on its owner.
		// Use agentKey or workflowKey when the Agent or Workflow is known.
		case "agent":
		case "workflow":
		case "model":
			return child(organizationKey(subject.organizationId))
	}
}

/**
 * The member at the top of the owner tree of an Agent.
 * It is `null` when the organization owns the Agent at the top.
 */
export const rootOf = (owner: AgentsApi.AgentOwner): string | null => {
	switch (owner._tag) {
		case "Organization":
			return null
		case "Member":
		case "Session":
		case "Agent":
			return owner.userId
	}
}

/** The place for the Agents of a member, or for shared Agents when `root` is `null`. */
export const agentPlace = ({
	organizationId,
	root,
}: {
	readonly organizationId: string
	readonly root: string | null
}) =>
	(root === null
		? organizationKey(organizationId)
		: userKey({ organizationId, userId: root })) + ".agent"

/**
 * The key of one Agent. Shared Agents, and the Agents below them, are below the organization.
 * The other Agents are below the member at the top of their owner tree.
 */
export const agentKey = (agent: {
	readonly organizationId: string
	readonly id: string
	readonly owner: AgentsApi.AgentOwner
}) =>
	agentPlace({
		organizationId: agent.organizationId,
		root: rootOf(agent.owner),
	}) +
	"." +
	segment(agent.id)

/**
 * The place for the Workflows of a member, or for shared Workflows when `root` is `null`.
 * A Workflow of an Agent is below the member at the top of the owner tree of that Agent.
 */
export const workflowPlace = ({
	organizationId,
	root,
}: {
	readonly organizationId: string
	readonly root: string | null
}) =>
	(root === null
		? organizationKey(organizationId)
		: userKey({ organizationId, userId: root })) + ".workflow"

/** The key of one Workflow. */
export const workflowKey = (workflow: {
	readonly organizationId: string
	readonly id: string
	readonly owner: WorkflowsApi.WorkflowOwner
}) =>
	workflowPlace({
		organizationId: workflow.organizationId,
		root: workflow.owner._tag === "Organization" ? null : workflow.owner.userId,
	}) +
	"." +
	segment(workflow.id)

/** Put the organization and the user of the caller into a resource pattern. */
export const expand = ({
	pattern,
	subject,
}: {
	readonly pattern: string
	readonly subject: Subject
}) =>
	pattern
		.replaceAll("{org}", segment(subject.organizationId))
		.replaceAll("{self}", segment(subject.userId))

/** A resource covers itself and every resource below it. */
const covers = (resource: string, key: string) =>
	key === resource || key.startsWith(resource + ".")

/** One permission on one resource, for one caller. */
export interface Check {
	readonly subject: Subject
	readonly permission: PermissionGroupId
	readonly key: string
}

/** A policy decision, or `none` when no policy matches. */
export type Decision = Permissions.Decision | "none"

/** An explicit deny wins over an allow. With no matching policy, the answer is "none". */
export const decide = (
	check: Check & { readonly policies: ReadonlyArray<Policy> },
): Decision => {
	const matching = check.policies.filter(
		(policy) =>
			policy.permissionGroups.includes(check.permission) &&
			policy.resources.some((resource) =>
				covers(
					expand({ pattern: resource, subject: check.subject }),
					check.key,
				),
			),
	)
	if (matching.some((policy) => policy.effect === "deny")) return "deny"
	return matching.length > 0 ? "allow" : "none"
}

/**
 * Each set of policies must allow the request on its own.
 * A user token has two sets: the policies of its member and its own policies.
 * The platform ceiling can only deny, and it comes first.
 */
export const allowed = (
	check: Check & {
		readonly sets: ReadonlyArray<ReadonlyArray<Policy>>
		readonly ceiling?: ReadonlyArray<Policy>
	},
) =>
	check.sets.length > 0 &&
	(check.ceiling === undefined ||
		decide({ ...check, policies: check.ceiling }) !== "deny") &&
	check.sets.every((policies) => decide({ ...check, policies }) === "allow")

/** The policies of a member: the policies of each role, then the extra policies. */
export const memberPolicies = ({
	member,
	roles,
}: {
	readonly member: {
		readonly roles: ReadonlyArray<Permissions.RoleId>
		readonly policies: ReadonlyArray<Policy>
	}
	readonly roles: ReadonlyArray<Permissions.Role>
}): ReadonlyArray<Policy> => [
	...roles
		.filter((role) => member.roles.includes(role.id))
		.flatMap((role) => role.policies),
	...member.policies,
]

/**
 * A policy may only name resources in its own organization.
 * The policies of a token may also name the platform, for platform admins.
 */
export const inOrganization = (input: {
	readonly policies: ReadonlyArray<Policy>
	readonly organizationId: string
	readonly platform?: boolean
}) =>
	input.policies.every(
		(policy) =>
			policy.resources.every(
				(resource) =>
					covers(Permissions.organizationResource, resource) ||
					covers(organizationKey(input.organizationId), resource) ||
					(input.platform === true &&
						resource === Permissions.platformResource),
			) &&
			// Platform permission groups only work on the platform.
			policy.permissionGroups.every(
				(group) =>
					!group.startsWith("platform.") ||
					policy.resources.every(
						(resource) => resource === Permissions.platformResource,
					),
			),
	)

/**
 * Tokens get this when the request leaves out policies: everything in the
 * organization except managing tokens. A token for the platform must say so.
 */
export const defaultTokenPolicies: ReadonlyArray<Policy> = [
	{
		effect: "allow",
		permissionGroups: Permissions.PermissionGroupId.literals.filter(
			(id) =>
				!Permissions.permissionGroupsOf("tokens").includes(id) &&
				!Permissions.permissionGroupsOf("platform").includes(id),
		),
		resources: [Permissions.organizationResource],
	},
]
