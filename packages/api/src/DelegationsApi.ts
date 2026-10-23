import { BotAuth } from "./AuthApi.ts"
import { Chat, Turn } from "@openbot-build/core"
import { Authorize, GroupRequired, requires } from "./Permissions.ts"
import { BotId } from "./BotsApi.ts"
import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"

export const DelegationId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
)
export type DelegationId = typeof DelegationId.Type

/** The status of a Delegation that has ended. */
export const DelegationResultStatus = Schema.Literals([
	"completed",
	"failed",
	"cancelled",
])
export type DelegationResultStatus = typeof DelegationResultStatus.Type
/** The status of a Delegation that has not ended yet. */
export const OpenDelegationStatus = Schema.Literals([
	"authorizing",
	"queued",
	"running",
])
export type OpenDelegationStatus = typeof OpenDelegationStatus.Type
export const DelegationStatus = Schema.Literals([
	...OpenDelegationStatus.literals,
	...DelegationResultStatus.literals,
])
export type DelegationStatus = typeof DelegationStatus.Type

/**
 * Where work came from: the Chat, and the Turn and tool call that gave it.
 * Work from a trigger has no Turn and no tool call.
 */
export const DelegationParent = Schema.Struct({
	chat: Chat.Id,
	turn: Schema.optionalKey(Turn.Id),
	toolCallId: Schema.optionalKey(Schema.String),
})
export type DelegationParent = typeof DelegationParent.Type

/**
 * One piece of work that a Bot gave to a Bot, maybe to itself. The work runs in its
 * own task Chat. When it ends, its result goes back to the parent Chat as a message.
 */
export const Delegation = Schema.Struct({
	id: DelegationId,
	parent: DelegationParent,
	/** The trigger that gave the work. */
	trigger: Schema.optionalKey(Schema.String),
	bot: BotId,
	/** The task Chat of the work. It is `null` until the work starts. */
	chat: Schema.NullOr(Chat.Id),
	status: DelegationStatus,
	/** What to do, in the words of the Bot that gave the work. */
	task: Schema.String,
	/** Why the Bot gave the work. A decider reads it. */
	reason: Schema.optionalKey(Schema.String),
	/** The last answer of the work. It is `null` until the work ends. */
	result: Schema.NullOr(Schema.String),
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
})
export type Delegation = typeof Delegation.Type

export class DelegationNotFound extends Schema.TaggedError<DelegationNotFound>()(
	"DelegationNotFound",
	{ delegation: Schema.String },
) {}
export class DelegationConflict extends Schema.TaggedError<DelegationConflict>()(
	"DelegationConflict",
	{ message: Schema.String },
) {}
export class DelegationStorageUnavailable extends Schema.TaggedError<DelegationStorageUnavailable>()(
	"DelegationStorageUnavailable",
	{},
) {}
export const DelegationErrors = [
	DelegationNotFound.pipe(HttpApiSchema.status(404)),
	DelegationConflict.pipe(HttpApiSchema.status(409)),
	DelegationStorageUnavailable.pipe(HttpApiSchema.status(503)),
] as const

const delegationParams = { delegationId: DelegationId }

export class DelegationsApi extends HttpApiGroup.make("delegations")
	.add(
		HttpApiEndpoint.get("getDelegation", "/v1/delegations/:delegationId", {
			params: delegationParams,
			success: Delegation,
			error: DelegationErrors,
		}).annotate(
			OpenApi.Description,
			"Reads one piece of work that a Bot gave away, from one of your Chats.",
		),
		HttpApiEndpoint.post(
			"cancelDelegation",
			"/v1/delegations/:delegationId/cancel",
			{
				params: delegationParams,
				payload: Schema.Struct({}),
				success: Delegation,
				error: DelegationErrors,
			},
		).annotate(
			OpenApi.Description,
			"Stops the work, and the work that it gave away. The parent Chat gets a message about it.",
		),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	// A Delegation belongs to a Chat of the caller. The handlers check that it is one.
	.annotate(GroupRequired, {
		read: [requires("chats.read").on("chat")],
		write: [requires("chats.write").on("chat")],
	})
	.middleware(Authorize)
	.middleware(BotAuth) {}
