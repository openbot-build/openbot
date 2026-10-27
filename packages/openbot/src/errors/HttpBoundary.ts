import { ExecutionsApi, FailureApi } from "@openbot-build/api"
import { Array as Arr, Cause, Effect, Layer, Schema } from "effect"
import { HttpServerResponse } from "effect/http"
import { HttpApi, HttpApiError } from "effect/http-api"
import { Records, category } from "./Records.ts"

export const errorIdHeader = "openbot-error-id"

/** Save server faults before the API encoder replaces their typed errors. */
export const layer = Layer.effect(
	FailureApi.FailureBoundary,
	Effect.gen(function* () {
		const records = yield* Records
		return (httpEffect, { endpoint, group }) => {
			// Reflection supplies status codes through Effect's public API.
			let expected: ReadonlyArray<Schema.Top> = []
			HttpApi.reflect(HttpApi.make("request-errors").add(group), {
				onGroup: () => undefined,
				predicate: ({ endpoint: selected }) =>
					selected.identifier === endpoint.identifier,
				onEndpoint: ({ errors }) => {
					expected = Arr.flatMap(
						Arr.fromIterable(errors),
						([status, schemas]) => (status < 500 ? schemas : []),
					)
				},
			})
			return httpEffect.pipe(
				Effect.catchCause((cause) =>
					Effect.gen(function* () {
						if (Cause.hasInterruptsOnly(cause))
							return yield* Effect.failCause(cause)
						const reason = cause.reasons[0]
						if (cause.reasons.length === 1 && reason?._tag === "Fail") {
							const error = reason.error
							if (
								HttpApiError.HttpApiPayloadTooLarge.is(error) ||
								(HttpApiError.HttpApiSchemaError.is(error) &&
									error.kind !== "Body" &&
									error.kind !== "ResponseHeaders") ||
								Arr.some(expected, (schema) => Schema.is(schema)(error))
							)
								return yield* Effect.failCause(cause)
						}
						const saved =
							cause.reasons.length === 1 &&
							reason?._tag === "Fail" &&
							Schema.is(ExecutionsApi.ExecutionUnavailable)(reason.error)
								? {
										category: "unavailable" as const,
										errorId: reason.error.errorId,
									}
								: yield* records.record(cause, category(cause)).pipe(
										Effect.annotateLogs({
											source: "http",
											operation: "http.request",
											method: endpoint.method,
											route: endpoint.path,
										}),
										Effect.orDie,
									)
						return yield* HttpServerResponse.schemaJson(
							FailureApi.RequestFailed,
						)(FailureApi.RequestFailed.make(saved), {
							status: 503,
							headers: { [errorIdHeader]: saved.errorId },
						}).pipe(Effect.orDie)
					}),
				),
			)
		}
	}),
)
