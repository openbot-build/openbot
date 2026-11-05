import { Execution } from "@openbot-build/domain"
import { Context, Effect, Schema } from "effect"
import type { Key } from "./Store.ts"

/** A saved owner event wakes a paused phase. No business data goes in this value. */
export class Paused extends Schema.TaggedError<
	Paused,
	{ readonly brand: unique symbol }
>()("ExecutionPaused", {
	namespace: Schema.String,
	id: Execution.Id,
	afterSequence: Execution.Sequence,
	/** A stable key for a condition that the owner must inspect. */
	wake: Schema.optionalKey(Schema.String),
}) {}

/** Read current state. With a lock, keep all owner locks until the send commits. */
export type Check = (
	key: Key,
	lock: boolean,
	call?: Execution.Call,
	intent?: Pick<Execution.Call, "retry" | "input">,
) => Effect.Effect<
	void,
	| Paused
	| Execution.Forbidden
	| Execution.NotFound
	| Execution.Conflict
	| Execution.StorageError
>

/** The active phase owns the stop. Nested tool error handlers cannot turn it into a result. */
export const CurrentPhase = Context.Reference<
	(pause: Paused) => Effect.Effect<never, Paused>
>("@openbot-build/openbot/execution/Admission/CurrentPhase", {
	defaultValue: () => Effect.fail,
})
export const stop = (pause: Paused) =>
	Effect.flatMap(CurrentPhase, (stop) => stop(pause))
