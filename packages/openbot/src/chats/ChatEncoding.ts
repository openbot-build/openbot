import { Chat, ChatStore, Config } from "@openbot-build/core"
import { Bots, Execution } from "@openbot-build/domain"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import { Array as Arr, Cause, Effect, Schema } from "effect"
import { SqlError } from "effect/sql"

/** Keep database failures retryable at the execution boundary. Codec errors stay failures. */
export const inExecution = <A, E, R>(work: Effect.Effect<A, E, R>) =>
	work.pipe(
		Effect.catchCause((cause) =>
			Effect.failCause(
				Cause.fromReasons<E | Execution.StorageError | Execution.Conflict>(
					Arr.flatMap(
						cause.reasons,
						(
							reason,
						): ReadonlyArray<
							Cause.Reason<E | Execution.StorageError | Execution.Conflict>
						> => {
							const error =
								reason._tag === "Fail"
									? reason.error
									: reason._tag === "Die"
										? reason.defect
										: undefined
							if (
								SqlError.isSqlError(error) ||
								Schema.is(EffectDrizzleQueryError)(error) ||
								Schema.is(Bots.BotStorageUnavailable)(error) ||
								(Schema.is(Config.ModelConfigurationError)(error) &&
									error.reason === "unavailable")
							)
								return Cause.fail(
									Execution.StorageError.make({
										cause: Cause.fromReasons([reason]),
									}),
								).reasons
							if (
								!Schema.is(ChatStore.ChatStoreError)(error) ||
								error.reason !== "storage-failed"
							)
								return [reason]
							if (Schema.is(Execution.Conflict)(error.cause))
								return Cause.fail(error.cause).reasons
							if (
								Schema.is(Execution.StorageError)(error.cause) ||
								SqlError.isSqlError(error.cause) ||
								Schema.is(EffectDrizzleQueryError)(error.cause)
							)
								return Cause.fail(
									Execution.StorageError.make({
										cause: Cause.fromReasons([reason]),
									}),
								).reasons
							return [reason]
						},
					),
				),
			),
		),
	)

/** Keeps a ChatStoreError. Any other database failure becomes `storage-failed` and keeps its cause. */
export const databaseError = (error: unknown): ChatStore.ChatStoreError =>
	Schema.is(ChatStore.ChatStoreError)(error)
		? error
		: ChatStore.ChatStoreError.make({
				reason: "storage-failed",
				message: "Chat storage is unavailable",
				cause: error,
			})
/** Decodes stored Chat data. A failure names the Chat when the caller knows it. */
export const decode =
	<S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
	(value: unknown, chat?: Chat.Id) =>
		Schema.decodeUnknownEffect(schema)(value).pipe(
			Effect.mapError((error) =>
				ChatStore.ChatStoreError.make({
					reason: "decode-failed",
					message: "Stored Chat data is invalid",
					issue: error.issue,
					...(chat === undefined ? {} : { chat }),
				}),
			),
		)
