import { ExecutionsApi, OpenBotApi } from "@openbot-build/api"

import { Execution, Identity } from "@openbot-build/domain"
import { Array as Arr, Cause, Context, Effect, Filter, Result } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Commands } from "./Commands.ts"
import { Records } from "../errors/Records.ts"
import * as HttpEvents from "./HttpEvents.ts"

type Errors =
	| Execution.NotFound
	| Execution.Forbidden
	| Execution.Conflict
	| Execution.KeyConflict
	| Execution.StorageError
const storageCause = Filter.make((cause: Cause.Cause<Errors>) => {
	const rest = Arr.reduce(
		cause.reasons,
		Cause.fromReasons<Exclude<Errors, Execution.StorageError>>([]),
		(rest, reason) => {
			if (reason._tag !== "Fail")
				return Cause.combine(rest, Cause.fromReasons([reason]))
			if (reason.error._tag === "ExecutionStorageError") return rest
			return Cause.combine(
				rest,
				Cause.fromReasons([
					Cause.makeFailReason(reason.error).annotate(
						Context.makeUnsafe(reason.annotations),
					),
				]),
			)
		},
	)
	return rest.reasons.length === cause.reasons.length
		? Result.fail(rest)
		: Result.succeed(cause)
})

export const layer = HttpApiBuilder.group(
	OpenBotApi,
	"executions",
	(handlers) =>
		Effect.gen(function* () {
			const commands = yield* Commands
			const records = yield* Records
			const events = yield* HttpEvents.make
			const unavailable = (cause: Cause.Cause<Errors>) =>
				records.record(cause, "unavailable").pipe(
					Effect.orDie,
					Effect.flatMap(({ errorId }) =>
						Effect.fail(ExecutionsApi.ExecutionUnavailable.make({ errorId })),
					),
				)
			const safe = <A, R>(
				effect: Effect.Effect<
					A,
					| Execution.NotFound
					| Execution.Forbidden
					| Execution.Conflict
					| Execution.KeyConflict
					| Execution.StorageError,
					R
				>,
			) => effect.pipe(Effect.catchCauseFilter(storageCause, unavailable))
			return handlers
				.handle("get", ({ params }) =>
					Effect.gen(function* () {
						return yield* commands.get(params.executionId, yield* Identity)
					}).pipe(safe),
				)
				.handle("events", ({ params, query }) =>
					Effect.gen(function* () {
						return yield* commands.events(
							params.executionId,
							yield* Identity,
							query.afterSequence ?? 0,
						)
					}).pipe(safe),
				)
				.handle("observe", ({ params, query }) =>
					Effect.gen(function* () {
						const actor = yield* Identity
						// Check before the response starts, so a rejected request has an HTTP status.
						yield* commands.get(params.executionId, actor)
						return events(
							params.executionId,
							commands.observe(
								params.executionId,
								actor,
								query.afterSequence ?? 0,
							),
						)
					}).pipe(safe),
				)
				.handle("cancel", ({ params, payload }) =>
					Effect.gen(function* () {
						return yield* commands.cancel(
							params.executionId,
							yield* Identity,
							payload.commandKey,
						)
					}).pipe(safe),
				)
				.handle("decide", ({ params, payload }) =>
					Effect.gen(function* () {
						return yield* commands.decide(
							params.executionId,
							yield* Identity,
							payload,
						)
					}).pipe(safe),
				)
		}),
)
