import { Authorization as OAuth } from "@openbot-build/protocol"
import { SecretStorageError } from "../secrets/Secrets.ts"
import { ExecutionsApi } from "@openbot-build/api"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Context,
	Effect,
	Filter,
	Result,
	Schema,
	PlatformError,
} from "effect"
import { Records } from "../errors/Records.ts"

type InternalError =
	| Execution.StorageError
	| Schema.SchemaError
	| PlatformError.PlatformError
	| SecretStorageError
	| OAuth.AuthorizationError
const internal = (error: unknown) =>
	Schema.is(Execution.StorageError)(error) ||
	Schema.is(SecretStorageError)(error) ||
	Schema.is(OAuth.AuthorizationError)(error) ||
	Schema.isSchemaError(error) ||
	PlatformError.isPlatformError(error)

/** Keep all causes when hiding a storage failure at the HTTP boundary. */
export const make = Effect.gen(function* () {
	const records = yield* Records
	return <A, E, R>(work: Effect.Effect<A, E, R>) =>
		work.pipe(
			Effect.catchCauseFilter(
				Filter.make((cause: Cause.Cause<E>) => {
					const rest = Arr.reduce(
						cause.reasons,
						Cause.fromReasons<Exclude<E, InternalError>>([]),
						(rest, reason) => {
							if (reason._tag !== "Fail")
								return Cause.combine(rest, Cause.fromReasons([reason]))
							if (internal(reason.error)) return rest
							// The runtime check above removes only the storage error from this union.
							const error = reason.error as Exclude<E, InternalError>
							return Cause.combine(
								rest,
								Cause.fromReasons([
									Cause.makeFailReason(error).annotate(
										Context.makeUnsafe(reason.annotations),
									),
								]),
							)
						},
					)
					return rest.reasons.length === cause.reasons.length
						? Result.fail(rest)
						: Result.succeed(cause)
				}),
				(cause) =>
					records.record(cause, "unavailable").pipe(
						Effect.orDie,
						Effect.flatMap(({ errorId }) =>
							Effect.fail(ExecutionsApi.ExecutionUnavailable.make({ errorId })),
						),
					),
			),
		)
})
