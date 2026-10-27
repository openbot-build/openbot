import { Execution } from "@openbot-build/domain"
import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
} from "effect/http-api"
import { BotAuth } from "./AuthApi.ts"
import { RequestFailed } from "./FailureApi.ts"

export { Execution } from "@openbot-build/domain"

export class ExecutionUnavailable extends Schema.TaggedError<
	ExecutionUnavailable,
	{ readonly brand: unique symbol }
>()("ExecutionUnavailable", { errorId: Execution.ErrorId }) {}
export const ExecutionForbidden = Execution.Forbidden
export type ExecutionForbidden = Execution.Forbidden

export const errors = [
	Execution.NotFound.pipe(HttpApiSchema.status(404)),
	Execution.Conflict.pipe(HttpApiSchema.status(409)),
	Execution.KeyConflict.pipe(HttpApiSchema.status(409)),
	ExecutionForbidden.pipe(HttpApiSchema.status(403)),
	ExecutionUnavailable.pipe(HttpApiSchema.status(503)),
] as const

/** Stream faults carry the same safe record reference as HTTP faults. */
export const ObservationError = Schema.Union([...errors, RequestFailed])

export const EventPage = Schema.Struct({
	events: Schema.Array(Execution.Event),
	afterSequence: Execution.Sequence,
	terminal: Schema.Boolean,
})

export const Decision = Schema.Struct({
	commandKey: Execution.CommandKey,
	decisionId: Execution.DecisionId,
	answer: Execution.Answer,
})
export type Decision = typeof Decision.Type

/** Authorization uses the business resource of the stored execution. */
export const ExecutionsApi = HttpApiGroup.make("executions")
	.add(
		HttpApiEndpoint.get("get", "/v1/executions/:executionId", {
			params: { executionId: Execution.Id },
			success: Execution.Record,
			error: errors,
		}),
		HttpApiEndpoint.get("events", "/v1/executions/:executionId/events", {
			params: { executionId: Execution.Id },
			query: {
				afterSequence: Schema.optionalKey(
					Schema.FiniteFromString.check(
						Schema.isInt(),
						Schema.isGreaterThanOrEqualTo(0),
					),
				),
			},
			success: EventPage,
			error: errors,
		}),
		HttpApiEndpoint.get("observe", "/v1/executions/:executionId/observe", {
			params: { executionId: Execution.Id },
			query: {
				afterSequence: Schema.optionalKey(
					Schema.FiniteFromString.check(
						Schema.isInt(),
						Schema.isGreaterThanOrEqualTo(0),
					),
				),
			},
			success: HttpApiSchema.StreamSse({
				error: ObservationError,
				events: Schema.Struct({
					event: Schema.Literal("execution"),
					id: Schema.String,
					data: Schema.fromJsonString(Execution.Event),
				}),
			}),
			error: errors,
		}),
		HttpApiEndpoint.post("cancel", "/v1/executions/:executionId/cancel", {
			params: { executionId: Execution.Id },
			payload: Schema.Struct({ commandKey: Execution.CommandKey }),
			success: Execution.Receipt,
			error: errors,
		}),
		HttpApiEndpoint.post("decide", "/v1/executions/:executionId/decisions", {
			params: { executionId: Execution.Id },
			payload: Decision,
			success: Execution.Receipt,
			error: errors,
		}),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	.middleware(BotAuth)
