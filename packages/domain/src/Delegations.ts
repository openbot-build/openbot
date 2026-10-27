import { Chat, Turn } from "@openbot-build/core"
import * as Execution from "./Execution.ts"
import { Array as Arr, Option, Schema } from "effect"
import { CapabilityRequestId } from "./CapabilityRequestId.ts"
import { TriggerId } from "./TriggerId.ts"
import { BotId } from "./BotId.ts"
import { DelegationId } from "./DelegationId.ts"
export { DelegationId } from "./DelegationId.ts"

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
	request: Schema.NullOr(CapabilityRequestId),
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
	trigger: Schema.optionalKey(TriggerId),
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

export class DelegationNotFound extends Schema.TaggedError<
	DelegationNotFound,
	{ readonly brand: unique symbol }
>()("DelegationNotFound", { delegation: DelegationId }) {}
export class DelegationConflict extends Schema.TaggedError<
	DelegationConflict,
	{ readonly brand: unique symbol }
>()("DelegationConflict", { message: Schema.String }) {}
export class DelegationStorageUnavailable extends Schema.TaggedError<
	DelegationStorageUnavailable,
	{ readonly brand: unique symbol }
>()("DelegationStorageUnavailable", {}) {}

/** The durable execution and safe failure of one piece of work. */
export const ExecutionView = Schema.Struct({
	delegation: Delegation,
	executionId: Execution.Id,
	status: Execution.Status,
	failure: Schema.NullOr(Execution.Failure),
})
export type ExecutionView = typeof ExecutionView.Type

/** Time has first place when more than one limit was reached. */
export const reached = (
	limits: DelegationLimits,
	usage: DelegationUsage,
	window: DelegationUsage,
): Option.Option<DelegationLimit> =>
	usage.timeMs - window.timeMs >= limits.timeMs
		? Option.some("time")
		: limits.steps !== undefined && usage.steps - window.steps >= limits.steps
			? Option.some("steps")
			: limits.budgetMicros !== undefined &&
				  usage.costMicros - window.costMicros >= limits.budgetMicros
				? Option.some("budget")
				: Option.none()

/** A saved pause names the task Turn and one limit window. */
export const LimitControl = Schema.Struct({
	kind: Schema.Literal("delegationLimit"),
	turnExecutionId: Execution.Id,
	epoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type LimitControl = typeof LimitControl.Type

/** A period in which a delegation is allowed to run. A null end is still open. */
export const RunningPeriod = Schema.Struct({
	start: Schema.Finite,
	end: Schema.NullOr(Schema.Finite),
})
export type RunningPeriod = typeof RunningPeriod.Type

/** Periods for one owner do not overlap. Work counts only while every owner can run. */
export const runningTime = (
	periods: ReadonlyArray<RunningPeriod>,
	ancestors: ReadonlyArray<ReadonlyArray<RunningPeriod>>,
	now: number,
): number => {
	const close = (period: RunningPeriod) => ({
		start: period.start,
		end: Math.min(period.end ?? now, now),
	})
	const active = Arr.reduce(
		ancestors,
		Arr.map(periods, close),
		(allowed, parent) =>
			Arr.flatMap(allowed, (child) =>
				Arr.flatMap(parent, (period) => {
					const start = Math.max(child.start, period.start)
					const end = Math.min(child.end, period.end ?? now, now)
					return end > start ? [{ start, end }] : []
				}),
			),
	)
	return Arr.reduce(
		active,
		0,
		(sum, period) => sum + Math.max(0, period.end - period.start),
	)
}
