import { type AgentsApi, Permissions } from "@openbot-build/platform-api"
import { Option } from "effect"

type PermissionGroupId = Permissions.PermissionGroupId
type Policy = Permissions.Policy
type RoleId = Permissions.RoleId

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
		// The key of one Agent depends on its owner. Use agentKey when the Agent is known.
		case "agent":
		case "model":
			return child(organizationKey(subject.organizationId))
	}
}

/**
 * The key of one Agent. Shared Agents are below the organization.
 * The Agents of a member, and the subagents in their Sessions, are below that member.
 */
export const agentKey = (agent: {
	readonly organizationId: string
	readonly id: string
	readonly owner: AgentsApi.AgentOwner
}) =>
	agent.owner._tag === "Organization"
		? organizationKey(agent.organizationId) + ".agent." + segment(agent.id)
		: userKey({
				organizationId: agent.organizationId,
				userId: agent.owner.userId,
			}) +
			".agent." +
			segment(agent.id)

/** Put the organization and the user of the caller into a resource pattern. */
const expand = (pattern: string, subject: Subject) =>
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
				covers(expand(resource, check.subject), check.key),
			),
	)
	if (matching.some((policy) => policy.effect === "deny")) return "deny"
	return matching.length > 0 ? "allow" : "none"
}

/**
 * Each set of policies must allow the request on its own.
 * A user token has two sets: the policies of its member and its own policies.
 */
export const allowed = (
	check: Check & {
		readonly sets: ReadonlyArray<ReadonlyArray<Policy>>
	},
) =>
	check.sets.length > 0 &&
	check.sets.every((policies) => decide({ ...check, policies }) === "allow")

/** The policies of a member: the policies of each role, then the extra policies. */
export const memberPolicies = (member: {
	readonly roles: ReadonlyArray<RoleId>
	readonly policies: ReadonlyArray<Policy>
}): ReadonlyArray<Policy> => [
	...Permissions.roles
		.filter((role) => member.roles.includes(role.id))
		.flatMap((role) => role.policies),
	...member.policies,
]

/** A policy may only name resources in its own organization. */
export const inOrganization = (input: {
	readonly policies: ReadonlyArray<Policy>
	readonly organizationId: string
}) =>
	input.policies.every((policy) =>
		policy.resources.every(
			(resource) =>
				covers(Permissions.organizationResource, resource) ||
				covers(organizationKey(input.organizationId), resource),
		),
	)

/** Tokens get this when the request leaves out policies: everything except managing tokens. */
export const defaultTokenPolicies: ReadonlyArray<Policy> = [
	{
		effect: "allow",
		permissionGroups: Permissions.PermissionGroupId.literals.filter(
			(id) => !Permissions.permissionGroupsOf("tokens").includes(id),
		),
		resources: [Permissions.organizationResource],
	},
]
