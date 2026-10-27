import { Chat, Config } from "@openbot-build/core"
import { Schema } from "effect"
import { BotId } from "./BotId.ts"
export { BotId } from "./BotId.ts"
import { Decision } from "./Authorization.ts"
import { Name } from "./Name.ts"
import { PlanApproval } from "./PlanApproval.ts"
import * as BotMemory from "./BotMemory.ts"

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
export const GrantId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/api/GrantId"))
export type GrantId = typeof GrantId.Type

export const RuleId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/api/RuleId"))
export type RuleId = typeof RuleId.Type

export const Decider = Schema.TaggedUnion({
	Person: { userId: Schema.String },
	Bot: { bot: BotId },
	Rule: { rule: RuleId },
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
	id: GrantId,
	bot: BotId,
	capability: Capability,
	effect: Decision,
	scope: GrantScope,
	chat: Schema.optionalKey(Chat.Id),
	grantedBy: Decider,
	reason: Schema.optionalKey(Schema.String),
	/** The Grant of the decider that this Grant came from. Revoking it revokes this one too. */
	parent: Schema.optionalKey(GrantId),
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
	id: RuleId,
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
export class BotNotFound extends Schema.TaggedError<
	BotNotFound,
	{ readonly brand: unique symbol }
>()("BotNotFound", { bot: Schema.String }) {}
export class RuleNotFound extends Schema.TaggedError<
	RuleNotFound,
	{ readonly brand: unique symbol }
>()("RuleNotFound", { rule: RuleId }) {}
export class GrantNotFound extends Schema.TaggedError<
	GrantNotFound,
	{ readonly brand: unique symbol }
>()("GrantNotFound", { grant: GrantId }) {}
export class BotConflict extends Schema.TaggedError<
	BotConflict,
	{ readonly brand: unique symbol }
>()("BotConflict", { message: Schema.String }) {}
export class BotInvalid extends Schema.TaggedError<
	BotInvalid,
	{ readonly brand: unique symbol }
>()("BotInvalid", {
	message: Schema.String,
}) {}
export class BotStorageUnavailable extends Schema.TaggedError<
	BotStorageUnavailable,
	{ readonly brand: unique symbol }
>()("BotStorageUnavailable", {}) {}
