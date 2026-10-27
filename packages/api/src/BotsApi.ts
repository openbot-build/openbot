import {
	BotId,
	BotMember,
	Bot,
	CreateBotRequest,
	UpdateBotRequest,
	GrantId,
	RuleId,
	GrantStatus,
	Grant,
	CreateGrantRequest,
	Rule,
	CreateRuleRequest,
	UpdateRuleRequest,
	BotMemoryView,
	UpdateBotMemoryRequest,
	BotNotFound,
	RuleNotFound,
	GrantNotFound,
	BotConflict,
	BotInvalid,
	BotStorageUnavailable,
} from "@openbot-build/domain/Bots"
export {
	BotId,
	BotOwner,
	BotSource,
	BotMember,
	Bot,
	CreateBotRequest,
	UpdateBotRequest,
	CapabilityAction,
	Capability,
	GrantId,
	RuleId,
	Decider,
	GrantScope,
	GrantStatus,
	Grant,
	CreateGrantRequest,
	RuleStatus,
	Rule,
	CreateRuleRequest,
	UpdateRuleRequest,
	BotMemoryView,
	UpdateBotMemoryRequest,
	BotNotFound,
	RuleNotFound,
	GrantNotFound,
	BotConflict,
	BotInvalid,
	BotStorageUnavailable,
} from "@openbot-build/domain/Bots"
import { Array as Arr, String as Str, SchemaTransformation, pipe } from "effect"
import { AccountAuth, BotAuth, NoStore } from "./AuthApi.ts"
import {
	Authorize,
	AuthorizationErrors,
	GroupRequired,
} from "./Authorization.ts"
import * as BotMemory from "./BotMemory.ts"
import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import {
	InvitationId,
	InvitationInvalid,
	InvitationNotFound,
	InvitationStatus,
} from "./Invitation.ts"

/** Only entries with all of these tags. Separate the tags with commas. */
const memoryQuery = {
	tags: Schema.optionalKey(
		Schema.NonEmptyString.pipe(
			Schema.decodeTo(
				Schema.Array(Schema.NonEmptyString),
				SchemaTransformation.transform({
					decode: (text): ReadonlyArray<string> =>
						pipe(
							text,
							Str.split(","),
							Arr.map(Str.trim),
							Arr.filter(Str.isNonEmpty),
						),
					encode: Arr.join(","),
				}),
			),
		),
	),
}

/** The handlers check permissions on Bots themselves, so these errors are listed here too. */
export const BotErrors = [
	...AuthorizationErrors,
	BotNotFound.pipe(HttpApiSchema.status(404)),
	BotConflict.pipe(HttpApiSchema.status(409)),
	BotInvalid.pipe(HttpApiSchema.status(400)),
	BotStorageUnavailable.pipe(HttpApiSchema.status(503)),
] as const

import {
	BotInvitation,
	CreateBotInvitationRequest,
	BotInvitationSecret,
	AcceptBotInvitationRequest,
} from "@openbot-build/domain/BotSharing"
export {
	InvitationSecretPrefix,
	BotInvitation,
	CreateBotInvitationRequest,
	BotInvitationSecret,
	AcceptBotInvitationRequest,
} from "@openbot-build/domain/BotSharing"
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
				archived: Schema.optionalKey(
					Schema.Literals(["true", "false"]).pipe(
						Schema.decodeTo(
							Schema.Boolean,
							SchemaTransformation.transform({
								decode: (text) => text === "true",
								encode: (flag) => (flag ? "true" : "false"),
							}),
						),
					),
				),
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
			params: { ...botParams, ruleId: RuleId },
			payload: UpdateRuleRequest,
			success: Rule,
			error: [...BotErrors, RuleNotFound.pipe(HttpApiSchema.status(404))],
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
			params: { ...botParams, grantId: GrantId },
			success: HttpApiSchema.NoContent,
			error: [...BotErrors, GrantNotFound.pipe(HttpApiSchema.status(404))],
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
