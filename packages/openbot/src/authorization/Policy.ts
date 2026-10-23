import {
	type BotsApi,
	type ComputersApi,
	Permissions,
	type TriggersApi,
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
	// The kind is the name of its key part, such as `chat`.
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
		case "chat":
		case "connection":
		case "request":
			return child(userKey(subject))
		// The key of one Bot, trigger or Computer depends on its owner.
		// Use botKey, triggerKey or computerKey when it is known.
		case "bot":
		case "trigger":
		case "computer":
		case "computer_provider":
		case "model":
		case "channel":
			return child(organizationKey(subject.organizationId))
	}
}

/**
 * The member at the top of the owner tree of a Bot.
 * It is `null` when the organization owns the Bot at the top.
 */
export const rootOf = (owner: BotsApi.BotOwner): string | null => {
	switch (owner._tag) {
		case "Organization":
			return null
		case "Member":
		case "Bot":
			return owner.userId
	}
}

/** The place for the Bots of a member, or for shared Bots when `root` is `null`. */
export const botPlace = ({
	organizationId,
	root,
}: {
	readonly organizationId: string
	readonly root: string | null
}) =>
	(root === null
		? organizationKey(organizationId)
		: userKey({ organizationId, userId: root })) + ".bot"

/**
 * The key of one Bot. Shared Bots, and the Bots below them, are below the organization.
 * The other Bots are below the member at the top of their owner tree.
 */
export const botKey = (bot: {
	readonly organizationId: string
	readonly id: string
	readonly owner: BotsApi.BotOwner
}) =>
	botPlace({
		organizationId: bot.organizationId,
		root: rootOf(bot.owner),
	}) +
	"." +
	segment(bot.id)

/** The place for the triggers of a member, or for shared triggers when `userId` is `null`. */
export const triggerPlace = (input: {
	readonly organizationId: string
	readonly userId: string | null
}) =>
	(input.userId === null
		? organizationKey(input.organizationId)
		: userKey({ organizationId: input.organizationId, userId: input.userId })) +
	".trigger"

/** The key of one trigger. */
export const triggerKey = (trigger: {
	readonly organizationId: string
	readonly id: string
	readonly owner: TriggersApi.TriggerOwner
}) =>
	triggerPlace({
		organizationId: trigger.organizationId,
		userId: trigger.owner._tag === "Member" ? trigger.owner.userId : null,
	}) +
	"." +
	segment(trigger.id)

/**
 * The place for the Computers of a member, or for shared Computers when `userId` is `null`.
 * `kind` is `computer` or `computer_provider`.
 */
export const computerPlace = (input: {
	readonly organizationId: string
	readonly userId: string | null
	readonly kind: "computer" | "computer_provider"
}) =>
	(input.userId === null
		? organizationKey(input.organizationId)
		: userKey({ organizationId: input.organizationId, userId: input.userId })) +
	"." +
	input.kind

/** The key of one Computer or Computer provider. */
export const computerKey = (input: {
	readonly organizationId: string
	readonly id: string
	readonly owner: ComputersApi.ComputerOwner
	readonly kind: "computer" | "computer_provider"
}) =>
	computerPlace({
		organizationId: input.organizationId,
		userId: input.owner._tag === "Member" ? input.owner.userId : null,
		kind: input.kind,
	}) +
	"." +
	segment(input.id)

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
