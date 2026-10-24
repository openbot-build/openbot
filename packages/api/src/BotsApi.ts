import { AccountAuth, BotAuth, NoStore, ReturnTo } from "./AuthApi.ts"
import {
	Authorize,
	AuthorizationErrors,
	Decision,
	GroupRequired,
} from "./Authorization.ts"
import { Chat, Config } from "@openbot-build/core"
import * as BotMemory from "./BotMemory.ts"
import { Name } from "./Name.ts"
import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { PlanApproval } from "./PlanApproval.ts"
import {
	InvitationId,
	InvitationInvalid,
	InvitationNotFound,
	InvitationStatus,
} from "./Invitation.ts"

export const BotId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/api/BotId"))
export type BotId = typeof BotId.Type

/**
 * Who owns a Bot.
 * A member owns their own Bots. The organization owns shared Bots.
 * A Bot can own Bots too. `userId` is the member at the top of this tree.
 * It is `null` when the organization owns the Bot at the top.
 */
export const BotOwner = Schema.TaggedUnion({
	Member: { userId: Schema.String },
	Organization: {},
	Bot: { bot: BotId, userId: Schema.NullOr(Schema.String) },
})
export type BotOwner = typeof BotOwner.Type

/** A Bot in another organization. */
export const BotSource = Schema.Struct({
	organizationId: Schema.String,
	bot: BotId,
})
export type BotSource = typeof BotSource.Type

/** A person who uses a shared Bot in their own organization. */
export const BotMember = Schema.Struct({
	userId: Schema.String,
	/** The organization where the person uses the Bot. */
	organizationId: Schema.String,
	/** The Bot in that organization that uses this Bot. */
	linked: BotId,
	joinedAt: Schema.Finite,
})
export type BotMember = typeof BotMember.Type

export const Bot = Schema.Struct({
	id: BotId,
	owner: BotOwner,
	name: Schema.String,
	role: Schema.String,
	/** The lasting instructions of the Bot, like a job description. */
	instructions: Schema.String,
	/** The model of the Chats of this Bot, when a Chat does not choose its own. */
	model: Schema.optionalKey(Config.Selection),
	/** How the plans of this Bot are approved. Without it, the settings of the member count. */
	planApproval: Schema.optionalKey(PlanApproval),
	/**
	 * The Bot that this Bot uses, when someone shared it with the owner. The name,
	 * role, instructions and model always come from that Bot, and only its people change them.
	 */
	source: Schema.optionalKey(BotSource),
	archived: Schema.Boolean,
	revision: Schema.Natural,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
})
export type Bot = typeof Bot.Type

const Text = Schema.String.check(Schema.isMaxLength(20000))

export const CreateBotRequest = Schema.Struct({
	name: Name,
	role: Schema.String.check(Schema.isMaxLength(500)),
	instructions: Text,
	model: Schema.optionalKey(Config.Selection),
	planApproval: Schema.optionalKey(PlanApproval),
	/** Shared Bots belong to the organization. Other Bots belong to the caller. */
	shared: Schema.optionalKey(Schema.Boolean),
	/** The Bot that owns the new Bot. You cannot use it together with `shared`. */
	bot: Schema.optionalKey(BotId),
})
export type CreateBotRequest = typeof CreateBotRequest.Type

export const UpdateBotRequest = Schema.Struct({
	expected: Schema.Natural,
	name: Schema.optionalKey(Name),
	role: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
	instructions: Schema.optionalKey(Text),
	model: Schema.optionalKey(Schema.NullOr(Config.Selection)),
	/** `null` makes the Bot follow the settings of the member again. */
	planApproval: Schema.optionalKey(Schema.NullOr(PlanApproval)),
	archived: Schema.optionalKey(Schema.Boolean),
})
export type UpdateBotRequest = typeof UpdateBotRequest.Type

/**
 * What a capability is: an action, the thing it acts on, and optional exact arguments.
 * `target` is `*` for every target.
 */
export const CapabilityAction = Schema.Literals([
	"tools.call",
	"apps.call",
	"bots.create",
	"bots.delegate",
	/** A Bot in plan mode wants to carry out its plan. The target is the Chat. */
	"plans.run",
	/** A Bot posts to a chat of a Channel. The target is the Channel. */
	"channels.send",
	/**
	 * Delegated work reached one of its limits and wants to go on. The target is the
	 * Delegation. The arguments name the limit.
	 */
	"delegations.continue",
	/** A Bot gets the right to use a Computer that exists. The target is the Computer. */
	"computers.acquire",
	/** A Bot makes a new Computer at a provider. The target is the Computer provider. */
	"computers.create",
	/** A Bot deletes a Computer with its sandbox. The target is the Computer. */
	"computers.delete",
	/** A Bot gives a port of a Computer a public address. The target is the Computer. */
	"computers.expose",
])
export type CapabilityAction = typeof CapabilityAction.Type
export const Capability = Schema.Struct({
	action: CapabilityAction,
	target: Schema.String.check(Schema.isMaxLength(512)),
	arguments: Schema.optionalKey(Schema.JsonObject),
})
export type Capability = typeof Capability.Type

/** A person, a Bot, or a Rule that made a decision. */
export const Decider = Schema.TaggedUnion({
	Person: { userId: Schema.String },
	Bot: { bot: BotId },
	Rule: { rule: Schema.String },
})
export type Decider = typeof Decider.Type

/**
 * How long a decision lasts.
 * `once` is used up by one call. `chat` lasts in one Chat. `lifetime` lasts until it is revoked.
 */
export const GrantScope = Schema.Literals(["once", "chat", "lifetime"])
export type GrantScope = typeof GrantScope.Type

/** `used` means a `once` Grant was used up. */
export const GrantStatus = Schema.Literals(["active", "used", "revoked"])
export type GrantStatus = typeof GrantStatus.Type

/** A stored decision about one capability of one Bot. The Bot never sees it. */
export const Grant = Schema.Struct({
	id: Schema.String,
	bot: BotId,
	capability: Capability,
	effect: Decision,
	scope: GrantScope,
	chat: Schema.optionalKey(Chat.Id),
	grantedBy: Decider,
	reason: Schema.optionalKey(Schema.String),
	/** The Grant of the decider that this Grant came from. Revoking it revokes this one too. */
	parent: Schema.optionalKey(Schema.String),
	status: GrantStatus,
	createdAt: Schema.Finite,
})
export type Grant = typeof Grant.Type

export const CreateGrantRequest = Schema.Struct({
	capability: Capability,
	effect: Decision,
	scope: GrantScope,
	reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
})
export type CreateGrantRequest = typeof CreateGrantRequest.Type

/** A `proposed` Rule waits for a person to confirm it. */
export const RuleStatus = Schema.Literals(["active", "proposed", "retired"])
export type RuleStatus = typeof RuleStatus.Type

/**
 * A rule in plain language that a decider uses to answer requests of one Bot.
 * A judge model reads it. Only a Rule that the judge quotes can allow a request.
 */
export const Rule = Schema.Struct({
	id: Schema.String,
	bot: BotId,
	author: Decider,
	text: Schema.String,
	status: RuleStatus,
	version: Schema.Natural,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
})
export type Rule = typeof Rule.Type

const RuleText = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(4000),
)
export const CreateRuleRequest = Schema.Struct({ text: RuleText })
export const UpdateRuleRequest = Schema.Struct({
	expected: Schema.Natural,
	text: Schema.optionalKey(RuleText),
	status: Schema.optionalKey(RuleStatus.pick(["active", "retired"])),
})
export type UpdateRuleRequest = typeof UpdateRuleRequest.Type

export const BotMemoryView = BotMemory.View
export type BotMemoryView = typeof BotMemoryView.Type
export const UpdateBotMemoryRequest = Schema.Struct({
	command: BotMemory.Edit,
})
export type UpdateBotMemoryRequest = typeof UpdateBotMemoryRequest.Type
/** Only entries with all of these tags. Separate the tags with commas. */
const memoryQuery = { tags: Schema.optionalKey(Schema.NonEmptyString) }

export class BotNotFound extends Schema.TaggedError<BotNotFound>()(
	"BotNotFound",
	{ bot: Schema.String },
) {}
export class BotConflict extends Schema.TaggedError<BotConflict>()(
	"BotConflict",
	{ message: Schema.String },
) {}
export class BotInvalid extends Schema.TaggedError<BotInvalid>()("BotInvalid", {
	message: Schema.String,
}) {}
export class BotStorageUnavailable extends Schema.TaggedError<BotStorageUnavailable>()(
	"BotStorageUnavailable",
	{},
) {}
/** The handlers check permissions on Bots themselves, so these errors are listed here too. */
export const BotErrors = [
	...AuthorizationErrors,
	BotNotFound.pipe(HttpApiSchema.status(404)),
	BotConflict.pipe(HttpApiSchema.status(409)),
	BotInvalid.pipe(HttpApiSchema.status(400)),
	BotStorageUnavailable.pipe(HttpApiSchema.status(503)),
] as const

/** The start of the secret of every Bot invitation link. */
export const InvitationSecretPrefix = "obai_"

/**
 * An invitation to use one Bot. With `email`, the person with this verified email can
 * accept it once. Without `email`, it is a link: everyone who has its secret can accept it,
 * until someone revokes it or it expires.
 */
export const BotInvitation = Schema.Struct({
	id: InvitationId,
	bot: BotId,
	email: Schema.NullOr(Schema.String),
	/** The first characters of the secret of a link, so people can tell links apart. */
	prefix: Schema.NullOr(Schema.String),
	/** A same-origin path where a client opens invitation links. */
	path: Schema.NullOr(ReturnTo),
	status: InvitationStatus,
	invitedBy: Schema.String,
	createdAt: Schema.String,
	/** A link without it never expires. */
	expiresAt: Schema.NullOr(Schema.String),
})
export type BotInvitation = typeof BotInvitation.Type
export const CreateBotInvitationRequest = Schema.Struct({
	/** Without it, the invitation is a link. */
	email: Schema.optionalKey(
		Schema.String.check(
			Schema.isMaxLength(320),
			Schema.isPattern(/^[^@\s]+@[^@\s]+$/),
		),
	),
	/** Milliseconds since 1970. An email invitation always lasts 7 days. */
	expiresAt: Schema.optionalKey(Schema.Finite),
	/**
	 * A path on the public origin where your client opens invitation links.
	 * With it, a link has a full `url` that you can show as a QR code.
	 */
	path: Schema.optionalKey(ReturnTo),
})
export type CreateBotInvitationRequest = typeof CreateBotInvitationRequest.Type
/**
 * An invitation with the secret of its link. `url` is the public origin, then `path`,
 * then `#` and the secret, so the secret never reaches a server log.
 */
export const BotInvitationSecret = Schema.Struct({
	invitation: BotInvitation,
	secret: Schema.NullOr(Schema.String),
	url: Schema.NullOr(Schema.String),
})
export type BotInvitationSecret = typeof BotInvitationSecret.Type
export const AcceptBotInvitationRequest = Schema.Struct({
	/** The ID of an email invitation. */
	invitation: Schema.optionalKey(InvitationId),
	/** The secret of an invitation link. */
	secret: Schema.optionalKey(
		Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
	),
	/**
	 * The organization where you use the Bot. You must be an active member of it.
	 * You can leave it out when you have only one organization.
	 */
	organization: Schema.optionalKey(Schema.String),
})
export type AcceptBotInvitationRequest = typeof AcceptBotInvitationRequest.Type

const botParams = { botId: BotId }
const invitationBotErrors = [
	...BotErrors,
	InvitationNotFound.pipe(HttpApiSchema.status(404)),
	InvitationInvalid.pipe(HttpApiSchema.status(400)),
] as const
export class BotsApi extends HttpApiGroup.make("bots")
	.add(
		HttpApiEndpoint.get("listBots", "/v1/bots", {
			query: {
				archived: Schema.optionalKey(Schema.Literals(["true", "false"])),
				bot: Schema.optionalKey(BotId),
			},
			success: Schema.Array(Bot),
			error: BotErrors,
		}).annotate(
			OpenApi.Description,
			"Lists the Bots that the caller can use: their own Bots and the shared Bots. With `bot`, it lists the Bots that this Bot owns.",
		),
		HttpApiEndpoint.post("createBot", "/v1/bots", {
			payload: CreateBotRequest,
			success: Bot.pipe(HttpApiSchema.status(201)),
			error: BotErrors,
		}),
		HttpApiEndpoint.get("getBot", "/v1/bots/:botId", {
			params: botParams,
			success: Bot,
			error: BotErrors,
		}),
		HttpApiEndpoint.patch("updateBot", "/v1/bots/:botId", {
			params: botParams,
			payload: UpdateBotRequest,
			success: Bot,
			error: BotErrors,
		}),
		HttpApiEndpoint.get("botMemory", "/v1/bots/:botId/memory", {
			params: botParams,
			query: memoryQuery,
			success: BotMemoryView,
			error: BotErrors,
		}).annotate(
			OpenApi.Description,
			"Reads the entries of the Bot memory that the caller may see: entries for the caller, for a Channel group that the caller is in, or for everyone who uses the Bot, in the organization of the caller. Nobody can read the memory about another person.",
		),
		HttpApiEndpoint.post("updateBotMemory", "/v1/bots/:botId/memory", {
			params: botParams,
			payload: UpdateBotMemoryRequest,
			success: BotMemoryView,
			error: BotErrors,
		}).annotate(
			OpenApi.Description,
			"Remembers something about the caller, or takes back what the caller gave to an entry.",
		),
		HttpApiEndpoint.get("botMemoryLog", "/v1/bots/:botId/memory/log", {
			params: botParams,
			success: Schema.Array(BotMemory.LogEntry),
			error: BotErrors,
		}).annotate(
			OpenApi.Description,
			"Lists the changes that touch entries that the caller may see.",
		),
		HttpApiEndpoint.post("purgeBotMemory", "/v1/bots/:botId/memory/purge", {
			params: botParams,
			payload: BotMemory.PurgeRequest,
			success: BotMemory.PurgeResult,
			error: BotErrors,
		}).annotate(
			OpenApi.Description,
			"Removes every entry with one tag of OpenBot, like `from:<userId>` or `chat:<id>`, without showing them. It needs `bots.write` on a Bot that is not linked.",
		),
		HttpApiEndpoint.get("memoryBot", "/v1/bots/:botId/memory/bot", {
			params: botParams,
			success: BotMemory.MemoryBotSettings,
			error: BotErrors,
		}).annotate(
			OpenApi.Description,
			"Reads the settings of the memory Bot that keeps the memory of this Bot. It needs `bots.write` on a Bot that is not linked.",
		),
		HttpApiEndpoint.patch("updateMemoryBot", "/v1/bots/:botId/memory/bot", {
			params: botParams,
			payload: BotMemory.UpdateMemoryBotRequest,
			success: BotMemory.MemoryBotSettings,
			error: BotErrors,
		}).annotate(
			OpenApi.Description,
			"Changes the rules, the concurrency and the budget of the memory Bot. It needs `bots.write` on a Bot that is not linked.",
		),
	)
	.add(
		HttpApiEndpoint.get("listRules", "/v1/bots/:botId/rules", {
			params: botParams,
			success: Schema.Array(Rule),
			error: BotErrors,
		}),
		HttpApiEndpoint.post("createRule", "/v1/bots/:botId/rules", {
			params: botParams,
			payload: CreateRuleRequest,
			success: Rule.pipe(HttpApiSchema.status(201)),
			error: BotErrors,
		}).annotate(
			OpenApi.Description,
			"Adds a Rule that the caller wrote for this Bot. A Rule from a person is active at once.",
		),
		HttpApiEndpoint.patch("updateRule", "/v1/bots/:botId/rules/:ruleId", {
			params: { ...botParams, ruleId: Schema.String },
			payload: UpdateRuleRequest,
			success: Rule,
			error: BotErrors,
		}).annotate(
			OpenApi.Description,
			"Changes the text of a Rule, confirms a proposed Rule, or retires a Rule.",
		),
		HttpApiEndpoint.get("listGrants", "/v1/bots/:botId/grants", {
			params: botParams,
			query: {
				status: Schema.optionalKey(GrantStatus),
			},
			success: Schema.Array(Grant),
			error: BotErrors,
		}),
		HttpApiEndpoint.post("createGrant", "/v1/bots/:botId/grants", {
			params: botParams,
			payload: CreateGrantRequest,
			success: Grant.pipe(HttpApiSchema.status(201)),
			error: BotErrors,
		}),
		HttpApiEndpoint.delete("revokeGrant", "/v1/bots/:botId/grants/:grantId", {
			params: { ...botParams, grantId: Schema.String },
			success: HttpApiSchema.NoContent,
			error: BotErrors,
		}).annotate(
			OpenApi.Description,
			"Revokes a Grant and every Grant that came from it.",
		),
	)
	.add(
		HttpApiEndpoint.get("listBotMembers", "/v1/bots/:botId/members", {
			params: botParams,
			success: Schema.Array(BotMember),
			error: BotErrors,
		}).annotate(
			OpenApi.Description,
			"Lists the people who use this Bot in their own organizations. It needs `bots.share`.",
		),
		HttpApiEndpoint.delete(
			"removeBotMember",
			"/v1/bots/:botId/members/:userId",
			{
				params: { ...botParams, userId: Schema.String },
				success: HttpApiSchema.NoContent,
				error: BotErrors,
			},
		).annotate(
			OpenApi.Description,
			"Takes a person off this Bot. Their linked Bot stops working at once.",
		),
		HttpApiEndpoint.post("createBotInvitation", "/v1/bots/:botId/invitations", {
			params: botParams,
			payload: CreateBotInvitationRequest,
			success: BotInvitationSecret.pipe(HttpApiSchema.status(201)),
			error: invitationBotErrors,
		}).annotate(
			OpenApi.Description,
			"Invites a person by email, or makes an invitation link, to use this Bot. It needs `bots.share`. Only a lasting top Bot can be shared.",
		),
		HttpApiEndpoint.get("listBotInvitations", "/v1/bots/:botId/invitations", {
			params: botParams,
			query: { status: Schema.optionalKey(InvitationStatus) },
			success: Schema.Array(BotInvitation),
			error: invitationBotErrors,
		}),
		HttpApiEndpoint.get(
			"botInvitationSecret",
			"/v1/bots/:botId/invitations/:invitationId/secret",
			{
				params: { ...botParams, invitationId: InvitationId },
				success: BotInvitationSecret,
				error: invitationBotErrors,
			},
		).annotate(
			OpenApi.Description,
			"Reads the secret and the URL of an invitation link again, for example to print its QR code again.",
		),
		HttpApiEndpoint.delete(
			"revokeBotInvitation",
			"/v1/bots/:botId/invitations/:invitationId",
			{
				params: { ...botParams, invitationId: InvitationId },
				success: HttpApiSchema.NoContent,
				error: invitationBotErrors,
			},
		).annotate(
			OpenApi.Description,
			"Takes back a pending invitation. People who accepted it stay members.",
		),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	// The resource key of a Bot depends on its owner, which the path does not show.
	// So the handlers check the bots permissions themselves.
	.annotate(GroupRequired, { read: [], write: [] })
	.middleware(Authorize)
	.middleware(BotAuth) {}

/** A person accepts an invitation to use a Bot. Any signed-in account can use it. */
export class BotInvitationsApi extends HttpApiGroup.make("botInvitations")
	.add(
		HttpApiEndpoint.post("acceptBotInvitation", "/v1/bot-invitations/accept", {
			payload: AcceptBotInvitationRequest,
			success: Bot,
			error: invitationBotErrors,
		}).annotate(
			OpenApi.Description,
			"Accepts an email invitation (`invitation`) or an invitation link (`secret`). It makes a linked Bot in your organization and gives it back. When you already use the Bot, it gives back your linked Bot.",
		),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	.middleware(AccountAuth)
	.middleware(NoStore) {}
