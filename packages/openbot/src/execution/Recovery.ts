import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Context,
	Effect,
	Layer,
	Schedule,
	Schema,
} from "effect"
import { Records, category } from "../errors/Records.ts"

export interface Service {
	readonly storage: <A, E, R>(
		id: Execution.Id,
		work: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | Execution.StorageError, R>
	readonly commit: <A, E, R>(
		id: Execution.Id,
		work: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | Execution.StorageError, R>
	readonly record: (
		cause: Cause.Cause<unknown>,
		id: Execution.Id,
		kind?: Execution.Failure["category"],
	) => Effect.Effect<
		{
			errorId: Execution.ErrorId
			category: Execution.Failure["category"]
		},
		never
	>
}

export class Recovery extends Context.Service<Recovery, Service>()(
	"@openbot-build/openbot/execution/Recovery",
) {}

export const make = Effect.gen(function* () {
	const errors = yield* Records
	const record = (
		cause: Cause.Cause<unknown>,
		id: Execution.Id,
		kind = category(cause),
	) =>
		errors
			.record(cause, kind, id)
			.pipe(Effect.retry(Schedule.spaced("1 second")), Effect.orDie)
	/** Retry storage at the nearest safe boundary. The caller still owns the scope. */
	const retry = <A, E, R>(
		id: Execution.Id,
		work: Effect.Effect<A, E, R>,
		commit: boolean,
	): Effect.Effect<A, E | Execution.StorageError, R> =>
		Effect.suspend(() => {
			let delay = 100
			const run: Effect.Effect<A, E | Execution.StorageError, R> = work.pipe(
				Effect.catchCauseIf(
					(cause) =>
						cause.reasons.length > 0 &&
						Arr.every(
							cause.reasons,
							(reason) =>
								reason._tag === "Fail" &&
								Schema.is(Execution.StorageError)(reason.error),
						),
					(cause) =>
						Effect.gen(function* () {
							const wait = record(cause, id).pipe(
								Effect.andThen(Effect.sleep(delay)),
							)
							yield* commit ? Effect.interruptible(wait) : wait
							delay = Math.min(delay * 2, 5000)
							return yield* run
						}),
				),
			)
			return commit ? Effect.uninterruptible(run) : run
		})
	const storage = <A, E, R>(id: Execution.Id, work: Effect.Effect<A, E, R>) =>
		retry(id, work, false)
	/** Protect the first commit too. Only a failed commit opens an interruptible wait. */
	const commit = <A, E, R>(id: Execution.Id, work: Effect.Effect<A, E, R>) =>
		retry(id, work, true)
	return Recovery.of({ storage, commit, record })
})

export const layer = Layer.effect(Recovery, make)
