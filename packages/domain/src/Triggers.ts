import * as Execution from "./Execution.ts"
import { Schema } from "effect"
import { BotId } from "./Bots.ts"
import { TriggerId } from "./TriggerId.ts"
export { TriggerId } from "./TriggerId.ts"

/** A member owns their own triggers. The organization owns shared triggers. */
export const TriggerOwner = Schema.TaggedUnion({
	Member: { userId: Schema.String },
	Organization: {},
})
export type TriggerOwner = typeof TriggerOwner.Type

/** When a trigger fires by itself. `cron` has five fields, such as `0 9 * * 1-5`. */
export const Schedule = Schema.Struct({
	cron: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
	/** An IANA time zone, such as `Europe/Berlin`. Without it, the time zone is UTC. */
	timeZone: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
})
export type Schedule = typeof Schedule.Type

/**
 * A trigger gives one task with one prompt to one Bot, on a schedule or from a webhook.
 * It does nothing else. The Bot decides how to do the work. When the task ends, its
 * result goes to the Chat of the actor with the Bot.
 */
export const Trigger = Schema.Struct({
	id: TriggerId,
	owner: TriggerOwner,
	bot: BotId,
	prompt: Schema.String,
	schedule: Schema.NullOr(Schedule),
	/** True when the trigger has a webhook secret. */
	webhook: Schema.Boolean,
	/**
	 * The member that the tasks work for. It is the last member who changed
	 * the trigger or its webhook.
	 */
	actor: Schema.String,
	enabled: Schema.Boolean,
	/** True when a saved change must set a caller before this trigger can fire. */
	needsAuthorization: Schema.Boolean,
	/** The next time that the schedule fires. `null` without a schedule, or when disabled. */
	nextRunAt: Schema.NullOr(Schema.Finite),
	executionId: Schema.NullOr(Execution.Id),
	lastFiredAt: Schema.NullOr(Schema.Finite),
	revision: Schema.Natural,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
})
export type Trigger = typeof Trigger.Type

const Prompt = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(20000),
)

export const Change = Schema.Struct({
	expected: Schema.Natural,
	bot: Schema.optionalKey(BotId),
	prompt: Schema.optionalKey(Prompt),
	/** `null` removes the schedule. */
	schedule: Schema.optionalKey(Schema.NullOr(Schedule)),
	enabled: Schema.optionalKey(Schema.Boolean),
})
export type Change = typeof Change.Type

export class TriggerNotFound extends Schema.TaggedError<
	TriggerNotFound,
	{ readonly brand: unique symbol }
>()("TriggerNotFound", { id: Schema.String }) {}
export class TriggerConflict extends Schema.TaggedError<
	TriggerConflict,
	{ readonly brand: unique symbol }
>()("TriggerConflict", { message: Schema.String }) {}
export class TriggerInvalid extends Schema.TaggedError<
	TriggerInvalid,
	{ readonly brand: unique symbol }
>()("TriggerInvalid", { message: Schema.String }) {}
export class TriggerStorageUnavailable extends Schema.TaggedError<
	TriggerStorageUnavailable,
	{ readonly brand: unique symbol }
>()("TriggerStorageUnavailable", {}) {}
/** The webhook secret is wrong, the trigger has no webhook, or it is disabled. */
export class TriggerHookDenied extends Schema.TaggedError<
	TriggerHookDenied,
	{ readonly brand: unique symbol }
>()("TriggerHookDenied", {}) {}
