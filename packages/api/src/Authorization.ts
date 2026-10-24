/**
 * The authorization model of OpenBot, made with `@nmnmcc/ability`.
 *
 * A resource is a kind of thing to act on, such as a Chat or a Bot. Each
 * resource has a list of actions and a path. The path puts the resource in a
 * tree: `org / <organization> / user / <owner> / bot / <id>`. A policy is a
 * tree of allow and deny rules. A rule names actions and resources, and its
 * condition can test the fields and the path of the resource.
 */
import {
	Authorizer,
	type Condition,
	Domain,
	Policy,
	Resource,
	type Rule,
} from "@nmnmcc/ability"
import * as AbilityHttpApi from "@nmnmcc/ability/HttpApi"
import { Schema } from "effect"
import { HttpApiMiddleware } from "effect/http-api"
import { Account, AccountCaller, Identity } from "./Identity.ts"

const ownFields = {
	organizationId: Schema.String,
	ownerUserId: Schema.String,
	id: Schema.String,
}
const sharedFields = {
	organizationId: Schema.String,
	/** `null` when the organization owns the resource and shares it. */
	ownerUserId: Schema.NullOr(Schema.String),
	id: Schema.String,
}
const userFields = {
	organizationId: Schema.String,
	ownerUserId: Schema.String,
}
const organizationFields = { organizationId: Schema.String }

/** The Chats of a user. `run` sends messages, so that Bots work. */
export class Chat extends Resource.Class<Chat>()("Chat", {
	actions: ["read", "write", "run"],
	fields: ownFields,
	path: (f) => ["org", f.organizationId, "user", f.ownerUserId, "chat", f.id],
}) {}

export class File extends Resource.Class<File>()("File", {
	actions: ["read", "write"],
	fields: ownFields,
	path: (f) => ["org", f.organizationId, "user", f.ownerUserId, "file", f.id],
}) {}

/** The requests of the Bots of a user for new capabilities. */
export class Request extends Resource.Class<Request>()("Request", {
	actions: ["resolve"],
	fields: ownFields,
	path: (f) => [
		"org",
		f.organizationId,
		"user",
		f.ownerUserId,
		"request",
		f.id,
	],
}) {}

export class Connection extends Resource.Class<Connection>()("Connection", {
	actions: ["read", "write"],
	fields: ownFields,
	path: (f) => [
		"org",
		f.organizationId,
		"user",
		f.ownerUserId,
		"connection",
		f.id,
	],
}) {}

/** The Apps of a user: the App index, App operations, and the developer tools. */
export class App extends Resource.Class<App>()("App", {
	actions: ["use", "publish"],
	fields: userFields,
	path: (f) => ["org", f.organizationId, "user", f.ownerUserId, "apps"],
}) {}

/** The API tokens of a user. */
export class Token extends Resource.Class<Token>()("Token", {
	actions: ["read", "write"],
	fields: userFields,
	path: (f) => ["org", f.organizationId, "user", f.ownerUserId, "token"],
}) {}

/** The accounts of a user on the platforms of Channels. */
export class ChannelIdentity extends Resource.Class<ChannelIdentity>()(
	"ChannelIdentity",
	{
		actions: ["read", "write"],
		fields: userFields,
		path: (f) => [
			"org",
			f.organizationId,
			"user",
			f.ownerUserId,
			"channel_identity",
		],
	},
) {}

export class Bot extends Resource.Class<Bot>()("Bot", {
	actions: ["read", "write", "delegate", "share"],
	fields: sharedFields,
	path: (f) => ["org", f.organizationId, "user", f.ownerUserId, "bot", f.id],
}) {}

export class Trigger extends Resource.Class<Trigger>()("Trigger", {
	actions: ["read", "write"],
	fields: sharedFields,
	path: (f) => [
		"org",
		f.organizationId,
		"user",
		f.ownerUserId,
		"trigger",
		f.id,
	],
}) {}

export class Computer extends Resource.Class<Computer>()("Computer", {
	actions: ["read", "write", "use"],
	fields: sharedFields,
	path: (f) => [
		"org",
		f.organizationId,
		"user",
		f.ownerUserId,
		"computer",
		f.id,
	],
}) {}

export class ComputerProvider extends Resource.Class<ComputerProvider>()(
	"ComputerProvider",
	{
		actions: ["read", "write", "use"],
		fields: sharedFields,
		path: (f) => [
			"org",
			f.organizationId,
			"user",
			f.ownerUserId,
			"computer_provider",
			f.id,
		],
	},
) {}

export class Channel extends Resource.Class<Channel>()("Channel", {
	actions: ["read", "write", "use"],
	fields: { organizationId: Schema.String, id: Schema.String },
	path: (f) => ["org", f.organizationId, "channel", f.id],
}) {}

/** A model of one model provider, that a Chat can use. */
export class Model extends Resource.Class<Model>()("Model", {
	actions: ["use"],
	fields: {
		organizationId: Schema.String,
		provider: Schema.String,
		id: Schema.String,
	},
	path: (f) => ["org", f.organizationId, "model", f.provider, f.id],
}) {}

export class Organization extends Resource.Class<Organization>()(
	"Organization",
	{
		actions: ["read", "write"],
		fields: organizationFields,
		path: (f) => ["org", f.organizationId],
	},
) {}

/** The custom roles of an organization. */
export class Role extends Resource.Class<Role>()("Role", {
	actions: ["write"],
	fields: organizationFields,
	path: (f) => ["org", f.organizationId],
}) {}

export class Member extends Resource.Class<Member>()("Member", {
	actions: ["read", "write"],
	fields: organizationFields,
	path: (f) => ["org", f.organizationId],
}) {}

export class ModelProvider extends Resource.Class<ModelProvider>()(
	"ModelProvider",
	{
		actions: ["read", "write"],
		fields: organizationFields,
		path: (f) => ["org", f.organizationId],
	},
) {}

/** The email domains and SSO connections of an organization. */
export class Sso extends Resource.Class<Sso>()("Sso", {
	actions: ["read", "write"],
	fields: organizationFields,
	path: (f) => ["org", f.organizationId],
}) {}

export class AuditLog extends Resource.Class<AuditLog>()("AuditLog", {
	actions: ["read"],
	fields: organizationFields,
	path: (f) => ["org", f.organizationId],
}) {}

/** The model usage, its cost, and the credits of an organization. */
export class Usage extends Resource.Class<Usage>()("Usage", {
	actions: ["read"],
	fields: organizationFields,
	path: (f) => ["org", f.organizationId],
}) {}

export class Budget extends Resource.Class<Budget>()("Budget", {
	actions: ["read", "write"],
	fields: organizationFields,
	path: (f) => ["org", f.organizationId],
}) {}

/** The whole deployment. Only platform admins may act on it. */
export class Platform extends Resource.Class<Platform>()("Platform", {
	actions: ["read", "write"],
	fields: {},
	path: () => ["platform"],
}) {}

/** The one platform value. */
export const platform = Platform.make({})

const resources = [
	Chat,
	File,
	Request,
	Connection,
	App,
	Token,
	ChannelIdentity,
	Bot,
	Trigger,
	Computer,
	ComputerProvider,
	Channel,
	Model,
	Organization,
	Role,
	Member,
	ModelProvider,
	Sso,
	AuditLog,
	Usage,
	Budget,
	Platform,
] as const

/**
 * The principal is the caller of a request: a member with the session cookie,
 * or a user token. `organizationId` is missing for a session that does not
 * act in one organization, such as a call to the platform API. A rule that
 * tests a missing principal field never matches.
 */
type Resources = (typeof resources)[number]
/**
 * The type of the domain. It is an interface, so that other packages can name
 * it in their declaration files.
 */
export interface OpenBotDomain extends Domain.Domain<
	AccountCaller,
	Resources,
	never
> {}
export const OpenBot: OpenBotDomain = Domain.make({
	principal: AccountCaller,
	resources,
})
export type OpenBot = OpenBotDomain

/** The name of a kind of resource, such as `Bot`. */
export type Kind = Domain.Kind<OpenBot>
export const Kind = Schema.Literals(resources.map((resource) => resource.kind))
/** The kinds that a user owns, with `ownerUserId` in their path. */
const ownKinds = [
	Chat,
	File,
	Request,
	Connection,
	App,
	Token,
	ChannelIdentity,
	Bot,
	Trigger,
	Computer,
	ComputerProvider,
] as const
/** Every kind of an organization. */
const organizationKinds = resources.filter(
	(resource) => resource !== Platform,
) as ReadonlyArray<Exclude<(typeof resources)[number], typeof Platform>>

const descriptions: {
	readonly [K in Kind]: {
		readonly [A in Domain.ActionOf<OpenBot, K>]: string
	}
} = {
	Chat: {
		read: "Read Chats, their history and the work that they gave away.",
		write:
			"Change, interrupt and delete Chats, and cancel the work that they gave away.",
		run: "Send messages to Bots, so that they work in a Chat.",
	},
	File: {
		read: "Read your files and their bytes.",
		write: "Upload and delete your files.",
	},
	Request: {
		resolve:
			"Answer the requests of your Bots for new capabilities, such as App tool calls.",
	},
	Connection: {
		read: "Read App connections and App accounts.",
		write:
			"Create, change and delete App connections, and sign in to App accounts.",
	},
	App: {
		use: "Find Apps, and use App operations and App views.",
		publish: "Use the developer tools for Apps that you publish.",
	},
	Token: {
		read: "List API tokens.",
		write: "Create and revoke API tokens.",
	},
	ChannelIdentity: {
		read: "Read your linked accounts on the platforms of Channels.",
		write: "Link and unlink your accounts on the platforms of Channels.",
	},
	Bot: {
		read: "Read Bots, their memory, Rules and Grants.",
		write: "Create and change Bots, their memory, Rules and Grants.",
		delegate: "Give work to a Bot, from a client or from another Bot.",
		share:
			"Invite other people to use a Bot, and manage the people who use it.",
	},
	Trigger: {
		read: "Read triggers: their schedules and webhooks.",
		write: "Create, change and delete triggers, and set their webhook secrets.",
	},
	Computer: {
		read: "Read Computers, the Bots that may use them, and their usage.",
		write:
			"Create, change and delete Computers, pair machines, and make connector tokens.",
		use: "Run commands, change files, open ports and use the desktop of Computers, and let your Bots use them.",
	},
	ComputerProvider: {
		read: "Read the accounts at Computer providers.",
		write:
			"Add, change and delete accounts at Computer providers, and their keys.",
		use: "Create Computers with an account at a Computer provider.",
	},
	Channel: {
		read: "Read the Channels of the organization and the people linked to them.",
		write:
			"Create, change and delete Channels, set their secrets, and unlink people.",
		use: "Talk with the Bot of a Channel, and let your Bots post to it.",
	},
	Model: {
		use: "Choose a model for a Chat, and see it in the model catalog.",
	},
	Organization: {
		read: "Read the name and settings of the organization.",
		write: "Change the name and settings of the organization.",
	},
	Role: {
		write: "Create, change and delete the custom roles of the organization.",
	},
	Member: {
		read: "List members, their roles and their policies.",
		write:
			"Change the roles, policies and status of members, and remove members.",
	},
	ModelProvider: {
		read: "Read the model providers of the organization. Keys are never shown.",
		write:
			"Add, change and remove the model providers and keys of the organization.",
	},
	Sso: {
		read: "Read the email domains and SSO connections.",
		write: "Add and verify email domains, and change SSO connections.",
	},
	AuditLog: { read: "Read the audit log." },
	Usage: {
		read: "Read the model usage and its cost, and the credits of the organization.",
	},
	Budget: {
		read: "Read the budgets and how much of them is spent.",
		write: "Create, change and delete budgets.",
	},
	Platform: {
		read: "Read the platform settings, organizations, admins and shared model providers. Only platform admins can use it.",
		write:
			"Change the platform settings, organizations, admins and shared model providers. Only platform admins can use it.",
	},
}

export const ResourceAction = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
})
/** A kind of resource, with its actions and the parts of its path. */
export const ResourceInfo = Schema.Struct({
	kind: Kind,
	actions: Schema.Array(ResourceAction),
	fields: Schema.Array(Schema.String),
	path: Schema.Array(Schema.String),
})
export type ResourceInfo = typeof ResourceInfo.Type

/** Every kind of resource. A field in the path is written as `{field}`. */
export const resourceInfo: ReadonlyArray<ResourceInfo> = resources.map(
	(resource) => {
		const descriptor = Resource.descriptor(resource)
		const actions = descriptions[resource.kind] as Record<string, string>
		return {
			kind: resource.kind,
			actions: descriptor.actions.map((name) => ({
				name,
				description: actions[name] ?? "",
			})),
			fields: descriptor.fieldPaths,
			path: (descriptor.path ?? []).map((segment) =>
				typeof segment === "string" ? segment : `{${segment.field}}`,
			),
		}
	},
)

/** A policy of OpenBot. It is an interface for the same reason as {@link OpenBotDomain}. */
export interface OpenBotPolicy extends Policy.Policy<OpenBotDomain> {}
const PolicyCodec: Schema.Codec<OpenBotPolicy, Policy.EncodedNode> =
	Policy.schema(OpenBot)
/** A policy of OpenBot. */
export type Policy = OpenBotPolicy

const countRules = (node: Policy.Node): number => {
	switch (node._tag) {
		case "Rules":
			return node.rules.length
		case "All":
		case "Any":
		case "FirstOf":
			return node.policies.reduce((sum, child) => sum + countRules(child), 0)
		case "Ceiling":
			return countRules(node.cap) + countRules(node.policy)
	}
}
const depth = (node: Policy.Node): number => {
	switch (node._tag) {
		case "Rules":
			return 1
		case "All":
		case "Any":
		case "FirstOf":
			return 1 + Math.max(0, ...node.policies.map(depth))
		case "Ceiling":
			return 1 + Math.max(depth(node.cap), depth(node.policy))
	}
}
/** The most rules in one policy. */
export const maxRules = 100
/** The deepest tree of one policy. */
export const maxDepth = 8

/**
 * The JSON form of a policy. Decoding checks every kind, action and field
 * against the resources of OpenBot.
 */
export const PolicySchema = PolicyCodec

/**
 * A policy in a request. It may have at most 100 rules and may be at most 8
 * levels deep. Stored policies have no such limit, so a policy from an older
 * version always loads.
 */
export const PolicyInput = PolicyCodec.check(
	Schema.makeFilter((policy: Policy) =>
		countRules(policy.node) > maxRules
			? `A policy may have at most ${maxRules} rules`
			: depth(policy.node) > maxDepth
				? `A policy may be at most ${maxDepth} levels deep`
				: undefined,
	),
)

/** A policy with no rules. It allows nothing and denies nothing. */
export const emptyPolicy: Policy = Policy.empty(OpenBot)

/** Gives true when every rule of a policy is a deny rule. */
export const onlyDenies = (policy: Policy): boolean => {
	const visit = (node: Policy.Node): boolean => {
		switch (node._tag) {
			case "Rules":
				return node.rules.every((rule) => rule._tag === "Deny")
			case "All":
			case "Any":
			case "FirstOf":
				return node.policies.every(visit)
			case "Ceiling":
				return visit(node.cap) && visit(node.policy)
		}
	}
	return visit(policy.node)
}

const denyOnly = Schema.makeFilter((policy: Policy) =>
	onlyDenies(policy)
		? undefined
		: "The platform ceiling may only have deny rules",
)

/**
 * The platform ceiling. It has only deny rules. Its deny rules stop an act in
 * every organization.
 */
export const CeilingSchema = PolicySchema.check(denyOnly)

/** The platform ceiling in a request. */
export const CeilingInput = PolicyInput.check(denyOnly)

/** Whether a rule or a Grant allows or denies something. */
export const Decision = Schema.Literals(["allow", "deny"])
export type Decision = typeof Decision.Type

const define = Policy.define(OpenBot)

type Builder = Rule.Builder<OpenBot>

/** The rule covers everything in the organization of the caller. */
const inOrganization = {
	when: <B extends Condition.Builder<any, any, AccountCaller>>($: B) =>
		$.under("org", $.principal("organizationId")),
}

const ownWork = (_: Builder) =>
	_.allow("*", ownKinds, {
		when: ($) =>
			$.under(
				"org",
				$.principal("organizationId"),
				"user",
				$.principal("userId"),
			),
	})
const sharedOf = <
	const K extends ReadonlyArray<
		typeof Bot | typeof Trigger | typeof Computer | typeof ComputerProvider
	>,
>(
	_: Builder,
	actions: ReadonlyArray<string>,
	kinds: K,
) =>
	_.allow(actions as never, kinds, {
		when: ($) =>
			$.and(
				$.under("org", $.principal("organizationId")),
				$.eq("ownerUserId", null),
			),
	})
const useSharedBots = (_: Builder) => sharedOf(_, ["read", "delegate"], [Bot])
const readSharedTriggers = (_: Builder) => sharedOf(_, ["read"], [Trigger])
const useChannels = (_: Builder) => _.allow("use", Channel, inOrganization)
const useSharedComputers = (_: Builder) =>
	sharedOf(_, ["read", "use"], [Computer, ComputerProvider])
const readSharedComputers = (_: Builder) =>
	sharedOf(_, ["read"], [Computer, ComputerProvider])

/**
 * Built-in roles. Every organization has them, and their policies cannot
 * change. An organization can add custom roles. Their IDs start with `role_`.
 */
export const builtinRoles = [
	{
		id: "super_administrator",
		name: "Super Administrator",
		description:
			"Every permission in the organization. Only a Super Administrator can give or take away this role.",
		policy: define(function* (_) {
			yield* _.allow("*", organizationKinds, inOrganization)
		}),
	},
	{
		id: "administrator",
		name: "Administrator",
		description:
			"Manage the organization, its members, its shared Bots, its shared triggers, its shared Computers and its Channels. Work only with your own Chats and connections.",
		policy: define(function* (_) {
			yield* ownWork(_)
			yield* useSharedBots(_)
			yield* readSharedTriggers(_)
			yield* useChannels(_)
			yield* useSharedComputers(_)
			yield* sharedOf(_, ["write", "share"], [Bot])
			yield* sharedOf(_, ["write"], [Computer, ComputerProvider])
			yield* sharedOf(_, ["write"], [Trigger])
			yield* _.allow(
				"*",
				[
					Model,
					Organization,
					Member,
					Role,
					ModelProvider,
					Sso,
					Channel,
					AuditLog,
					Usage,
					Budget,
				],
				inOrganization,
			)
		}),
	},
	{
		id: "administrator_read_only",
		name: "Administrator Read Only",
		description:
			"Read the organization, its members, usage, budgets and the audit log. Work only with your own Chats and connections.",
		policy: define(function* (_) {
			yield* ownWork(_)
			yield* useSharedBots(_)
			yield* readSharedTriggers(_)
			yield* useChannels(_)
			yield* readSharedComputers(_)
			yield* _.allow("use", Model, inOrganization)
			yield* _.allow(
				"read",
				[
					Organization,
					Member,
					ModelProvider,
					Sso,
					Channel,
					AuditLog,
					Usage,
					Budget,
				],
				inOrganization,
			)
		}),
	},
	{
		id: "member",
		name: "Member",
		description:
			"Work with your own Bots, Chats, triggers, Computers, connections and tokens, and use the shared Bots, triggers, Computers, Channels and models of the organization.",
		policy: define(function* (_) {
			yield* ownWork(_)
			yield* useSharedBots(_)
			yield* readSharedTriggers(_)
			yield* useChannels(_)
			yield* useSharedComputers(_)
			yield* _.allow("use", Model, inOrganization)
			yield* _.allow("read", Organization, inOrganization)
		}),
	},
	{
		id: "auditor",
		name: "Auditor",
		description:
			"Read the organization, its members, usage, budgets and the audit log.",
		policy: define(function* (_) {
			yield* _.allow(
				"read",
				[Organization, Member, AuditLog, Usage, Budget],
				inOrganization,
			)
		}),
	},
] as const satisfies ReadonlyArray<{
	readonly id: string
	readonly name: string
	readonly description: string
	readonly policy: Policy
}>

/**
 * The policy of a new user token with no policy of its own: every act of its
 * member, except acts on tokens and on the platform.
 */
export const defaultTokenPolicy: Policy = define(function* (_) {
	yield* _.allow(
		"*",
		organizationKinds.filter((resource) => resource !== Token),
	)
})

/**
 * Checks the principal of a request that acts in one organization. The layer
 * is in `@openbot-build/openbot`.
 */
export class Auth extends Authorizer.Service<Auth, { requires: Identity }>()(
	"@openbot-build/api/Authorization/Auth",
	OpenBot,
) {}

/** Checks the principal of a platform request, which may have no organization. */
export class PlatformAuth extends Authorizer.Service<
	PlatformAuth,
	{ requires: Account }
>()("@openbot-build/api/Authorization/PlatformAuth", OpenBot) {}

/**
 * The errors of a check: `Forbidden` (403) when the policy says no, and
 * `PolicyUnavailable` (503) when OpenBot can not load the policy.
 */
export const AuthorizationErrors: typeof AbilityHttpApi.errors =
	AbilityHttpApi.errors
export const Forbidden: typeof Authorizer.Forbidden = Authorizer.Forbidden
export type Forbidden = Authorizer.Forbidden
export const PolicyUnavailable: typeof Authorizer.PolicyUnavailable =
	Authorizer.PolicyUnavailable
export type PolicyUnavailable = Authorizer.PolicyUnavailable

/**
 * Checks the `Required` annotation of each endpoint, or the `GroupRequired`
 * annotation of its group, with the policy of the caller.
 * An endpoint without either annotation fails, so a new endpoint cannot be
 * open by mistake.
 * @effect-expect-leaking RouteContext
 */
export class Authorize extends HttpApiMiddleware.Service<
	Authorize,
	{ readonly requires: Identity }
>()("@openbot-build/api/Authorization/Authorize", {
	error: AuthorizationErrors,
}) {}

/** The same checks as {@link Authorize}, for the platform API. */
export class PlatformAuthorize extends HttpApiMiddleware.Service<
	PlatformAuthorize,
	{ readonly requires: Account }
>()("@openbot-build/api/Authorization/PlatformAuthorize", {
	error: AuthorizationErrors,
}) {}

export const Required = AbilityHttpApi.Required
export const GroupRequired = AbilityHttpApi.GroupRequired
export type Requirement = AbilityHttpApi.Requirement

type OwnKind =
	| "Chat"
	| "File"
	| "Request"
	| "Connection"
	| "App"
	| "Token"
	| "ChannelIdentity"
type OrganizationKind =
	| "Organization"
	| "Role"
	| "Member"
	| "ModelProvider"
	| "Sso"
	| "AuditLog"
	| "Usage"
	| "Budget"

/**
 * An act on the resources of the caller. With `param`, the path parameter
 * names one resource, and the check is on that one.
 */
export const own = <const K extends OwnKind>(
	action: Domain.ActionOf<OpenBot, K>,
	kind: K,
	param?: string,
): Requirement =>
	AbilityHttpApi.requiresWhere(
		Auth,
		action as never,
		kind,
		(params, caller) =>
			({
				organizationId: caller.organizationId ?? "",
				ownerUserId: caller.userId,
				...(param === undefined ? {} : { id: params[param] ?? "" }),
			}) as never,
	)

/** An act on the organization of the caller, such as reading its members. */
export const organization = <const K extends OrganizationKind>(
	action: Domain.ActionOf<OpenBot, K>,
	kind: K,
): Requirement =>
	AbilityHttpApi.requiresWhere(
		Auth,
		action as never,
		kind,
		(_, caller) => ({ organizationId: caller.organizationId ?? "" }) as never,
	)

/** An act on one Channel, named by a path parameter. */
export const channel = (
	action: Domain.ActionOf<OpenBot, "Channel">,
	param: string,
): Requirement =>
	AbilityHttpApi.requiresWhere(Auth, action, "Channel", (params, caller) => ({
		organizationId: caller.organizationId ?? "",
		id: params[param] ?? "",
	}))

/** An act on the platform. */
export const onPlatform = (
	action: Domain.ActionOf<OpenBot, "Platform">,
): Requirement =>
	AbilityHttpApi.requiresWhere(PlatformAuth, action, "Platform", () => ({}))
