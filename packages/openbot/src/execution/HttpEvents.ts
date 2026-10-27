import { ExecutionsApi, FailureApi } from "@openbot-build/api"
import { Execution } from "@openbot-build/domain"
import { Array as Arr, Cause, Effect, Schema, Stream } from "effect"
import { Sse } from "effect/encoding"
import { HttpServerResponse } from "effect/http"
import { Records, category } from "../errors/Records.ts"

const rejection = Schema.is(
	Schema.Union([
		Execution.NotFound,
		Execution.Forbidden,
		Execution.Conflict,
		Execution.KeyConflict,
	]),
)
const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(Execution.Event))
const encodeFailure = Schema.encodeEffect(
	Schema.fromJsonString(
		Schema.toCodecJson(
			Schema.Cause(ExecutionsApi.ObservationError, Schema.Never),
		),
	),
)
const failureEvent = (
	cause: Cause.Cause<typeof ExecutionsApi.ObservationError.Type>,
) =>
	encodeFailure(cause).pipe(
		Effect.map((data) =>
			Sse.encoder.write({
				_tag: "Event",
				event: "effect/http-api/stream/failure",
				id: undefined,
				data,
			}),
		),
	)

/** Encode before the error boundary, so neither event nor error faults can leak. */
export const make = Effect.gen(function* () {
	const records = yield* Records
	return <E>(id: Execution.Id, events: Stream.Stream<Execution.Event, E>) =>
		// Effect's default SSE encoder sends defects. A raw response closes on later faults.
		HttpServerResponse.stream(
			events.pipe(
				Stream.mapEffect((event) =>
					encodeEvent(event).pipe(
						Effect.map((data) =>
							Sse.encoder.write({
								_tag: "Event",
								event: "execution",
								id: String(event.sequence),
								data,
							}),
						),
					),
				),
				Stream.catchCause((cause) => {
					if (Cause.hasInterruptsOnly(cause))
						return Stream.failCause(
							Cause.fromReasons<never>(
								Arr.filter(cause.reasons, Cause.isInterruptReason),
							),
						)
					const reason = cause.reasons[0]
					if (
						cause.reasons.length === 1 &&
						reason?._tag === "Fail" &&
						rejection(reason.error)
					)
						return Stream.fromEffect(failureEvent(Cause.fail(reason.error)))
					return Stream.fromEffect(
						records
							.record(cause, category(cause), id)
							.pipe(
								Effect.flatMap((failure) =>
									failureEvent(
										Cause.fail(FailureApi.RequestFailed.make(failure)),
									),
								),
							),
					)
				}),
				Stream.encodeText,
			),
			{
				contentType: "text/event-stream",
				headers: { "cache-control": "no-cache" },
			},
		)
})
