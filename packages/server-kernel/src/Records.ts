import { Authorizer } from "@nmnmcc/ability"
import { Execution } from "@openbot-build/domain"
import {
	Cause,
	Array as Arr,
	Clock,
	Context,
	Effect,
	Layer,
	Option,
	Redacted,
	Schema,
} from "effect"
import { SecureRandom } from "effect/crypto"
import * as Db from "@openbot-build/server-database/Database"
import { executionFailures } from "@openbot-build/server-database/ExecutionSchema"
import { Secrets } from "./Secrets.ts"

import { codec, snapshot } from "./Snapshot.ts"
/**
 * The public category of a failure. It is known only for a single failure
 * whose error class gives its category (see `Execution.category`). Every
 * other cause is `unavailable`.
 */
export const category = (cause: Cause.Cause<unknown>): Execution.Category => {
	const reason = cause.reasons[0]
	if (cause.reasons.length !== 1 || reason?._tag !== "Fail")
		return "unavailable"
	if (Schema.is(Execution.Failure)(reason.error)) return reason.error.category
	// The errors of this library can not carry the annotation of OpenBot.
	if (
		Schema.is(Schema.Union([Authorizer.Forbidden, Authorizer.Pending]))(
			reason.error,
		)
	)
		return "forbidden"
	return Option.getOrElse(
		Execution.categoryOf(reason.error),
		() => "unavailable" as const,
	)
}
export interface Service {
	readonly record: (
		cause: Cause.Cause<unknown>,
		category: Execution.Category,
		executionId?: Execution.Id | undefined,
	) => Effect.Effect<
		{
			errorId: Execution.ErrorId
			category: Execution.Category
		},
		Execution.StorageError
	>
}

export class Records extends Context.Service<Records, Service>()(
	"@openbot-build/server-kernel/Records",
) {}

const make = Effect.gen(function* () {
	const db = yield* Db.make
	const secrets = yield* Secrets
	const crypto = yield* SecureRandom.SecureRandom
	const record = Effect.fn("ErrorRecords.record")(
		function* (
			cause: Cause.Cause<unknown>,
			category: Execution.Category,
			executionId?: Execution.Id,
		) {
			// A saved failure is a reference to its full cause. Keep that reference across layers.
			const reason = cause.reasons[0]
			if (
				cause.reasons.length === 1 &&
				reason?._tag === "Fail" &&
				Schema.is(Execution.Failure)(reason.error)
			)
				return { errorId: reason.error.errorId, category }
			const errorId = Execution.ErrorId.make(yield* crypto.uuidV7())
			const saved = yield* secrets.seal(
				yield* cause.pipe(snapshot, Schema.encodeEffect(codec)),
				`failure:${errorId}`,
			)
			yield* db
				.insert(executionFailures)
				.values({
					id: errorId,
					executionId: executionId ?? null,
					cause: saved,
					createdAt: yield* Clock.currentTimeMillis,
				})
				.pipe(
					Effect.catchCause((writeCause) =>
						Effect.gen(function* () {
							if (Cause.hasInterruptsOnly(writeCause))
								return yield* Effect.failCause(
									Cause.fromReasons<never>(
										Arr.filter(writeCause.reasons, Cause.isInterruptReason),
									),
								)
							// Save the first sealed cause before the next seal can fail.
							yield* Effect.logError(
								"The error store is down. Keep this sealed record for repair.",
							).pipe(Effect.annotateLogs({ errorId, sealedCause: saved }))
							const storageCause = yield* secrets.seal(
								yield* writeCause.pipe(snapshot, Schema.encodeEffect(codec)),
								`failure:${errorId}:storage`,
							)
							yield* Effect.logError(
								"The error store is down. Keep this sealed record for repair.",
							).pipe(
								Effect.annotateLogs({
									errorId,
									sealedCause: saved,
									sealedStorageCause: storageCause,
								}),
							)
						}).pipe(
							Effect.catchCause((fallbackCause) =>
								Effect.failCause(Cause.combine(writeCause, fallbackCause)),
							),
						),
					),
				)
			yield* Effect.logError(
				"An operation failed. Its cause is in the sealed error record.",
			).pipe(
				Effect.annotateLogs({
					errorId,
					category,
					executionId: executionId ?? "none",
				}),
			)
			return { errorId, category }
		},
		(effect, original) =>
			effect.pipe(
				Effect.catchCause((recording) => {
					if (Cause.hasInterruptsOnly(recording))
						return Effect.failCause(
							Cause.fromReasons<never>(
								Arr.filter(recording.reasons, Cause.isInterruptReason),
							),
						)
					return Effect.fail(
						Execution.StorageError.make({
							cause: Redacted.make(Cause.combine(original, recording)),
						}),
					)
				}),
			),
	)
	return Records.of({ record })
})

export const layer = Layer.effect(Records, make)
