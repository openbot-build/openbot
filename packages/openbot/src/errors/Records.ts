import { Authorizer } from "@nmnmcc/ability"
import {
	Bots,
	ChatModelInvalid,
	Developers,
	Execution,
} from "@openbot-build/domain"
import {
	Cause,
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Redacted,
	Schema,
} from "effect"
import * as Db from "../database/Database.ts"
import { executionFailures } from "../database/ExecutionSchema.ts"
import { Secrets } from "../secrets/Secrets.ts"

import { codec, snapshot } from "./Snapshot.ts"
/** A public category is chosen only from a single known domain failure. */
export const category = (
	cause: Cause.Cause<unknown>,
): Execution.Failure["category"] => {
	const reason = cause.reasons[0]
	if (cause.reasons.length !== 1 || reason?._tag !== "Fail")
		return "unavailable"
	if (Schema.is(Execution.Failure)(reason.error)) return reason.error.category
	if (
		Schema.is(
			Schema.Union([
				Execution.Forbidden,
				Developers.DeveloperForbidden,
				Authorizer.Forbidden,
				Authorizer.Pending,
			]),
		)(reason.error)
	)
		return "forbidden"
	if (
		Schema.is(
			Schema.Union([ChatModelInvalid, Developers.DeveloperInputInvalid]),
		)(reason.error)
	)
		return "invalid"
	if (
		Schema.is(
			Schema.Union([
				Execution.NotFound,
				Bots.BotNotFound,
				Developers.DeveloperNotFound,
			]),
		)(reason.error)
	)
		return "not_found"
	if (
		Schema.is(
			Schema.Union([
				Execution.Conflict,
				Execution.KeyConflict,
				Developers.DeveloperConflict,
			]),
		)(reason.error)
	)
		return "conflict"
	return "unavailable"
}
export interface Service {
	readonly record: (
		cause: Cause.Cause<unknown>,
		category: Execution.Failure["category"],
		executionId?: Execution.Id | undefined,
	) => Effect.Effect<
		{
			errorId: Execution.ErrorId
			category: Execution.Failure["category"]
		},
		Execution.StorageError
	>
}

export class Records extends Context.Service<Records, Service>()(
	"@openbot-build/openbot/errors/Records",
) {}

const make = Effect.gen(function* () {
	const db = yield* Db.make
	const secrets = yield* Secrets
	const crypto = yield* Crypto.Crypto
	const record = Effect.fn("ErrorRecords.record")(
		function* (
			cause: Cause.Cause<unknown>,
			category: Execution.Failure["category"],
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
			const errorId = Execution.ErrorId.make(yield* crypto.randomUUIDv4())
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
