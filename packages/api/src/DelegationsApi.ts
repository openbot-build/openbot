import { BotAuth } from "./AuthApi.ts"
import { Chat, Turn } from "@openbot-build/core"
import { Authorize, GroupRequired, own } from "./Authorization.ts"
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
/**
 * The status of a Delegation that has not ended yet. Work is `paused` when it reached
 * one of its limits, or when work above it did. Then a decider says whether it goes on.
 */
export const OpenDelegationStatus = Schema.Literals([
	"authorizing",
	"queued",
	"running",
	"paused",
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

/** A limit of delegated work. */
export const DelegationLimit = Schema.Literals(["time", "steps", "budget"])
export type DelegationLimit = typeof DelegationLimit.Type

/**
 * How much the work may use before it pauses and asks its decider. The time is
 * required. When the decider lets the work go on, it gets the same limits again.
 */
export const DelegationLimits = Schema.Struct({
	/**
	 * The running time, in milliseconds, from 1 second to 30 days. Time in a pause
	 * does not count.
	 */
	timeMs: Schema.Int.check(
		Schema.isBetween({ minimum: 1000, maximum: 30 * 24 * 60 * 60 * 1000 }),
	),
	/** The model steps of the task Chat. A step is one call to the model. */
	steps: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
	/** The cost of the model calls of the work and of all the work it gave away, in micro-USD. */
	budgetMicros: Schema.optionalKey(
		Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
	),
})
export type DelegationLimits = typeof DelegationLimits.Type

/** What the work used since it started. The cost is the cost when OpenBot last checked it. */
export const DelegationUsage = Schema.Struct({
	timeMs: Schema.Finite,
	steps: Schema.Int,
	costMicros: Schema.Finite,
})
export type DelegationUsage = typeof DelegationUsage.Type

/**
 * Why paused work waits. `request` is the request that decides whether the work goes
 * on. Work below paused work pauses too: then `delegation` is the work above it whose
 * limit was reached, and `request` is null, because only that work asks.
 */
export const DelegationPause = Schema.Struct({
	limit: DelegationLimit,
	request: Schema.NullOr(Schema.String),
	delegation: Schema.optionalKey(DelegationId),
	at: Schema.Finite,
})
export type DelegationPause = typeof DelegationPause.Type

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
	/** Missing on work from before limits. */
	limits: Schema.optionalKey(DelegationLimits),
	usage: Schema.optionalKey(DelegationUsage),
	/** Set while the work is `paused`. */
	pause: Schema.optionalKey(DelegationPause),
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
		read: [own("read", "Chat")],
		write: [own("write", "Chat")],
	})
	.middleware(Authorize)
	.middleware(BotAuth) {}
