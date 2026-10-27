import {
	Cause,
	Context,
	Crypto,
	Effect,
	Option,
	Redacted,
	type Types,
} from "effect"
import { Records } from "./Records.ts"
import { errorIdHeader } from "./HttpBoundary.ts"
import {
	HttpEffect,
	HttpRouter,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"

/** Before keys and storage are ready, retain the failure without printing secrets. */
const startup = (cause: Cause.Cause<unknown>) =>
	Effect.logError("OpenBot could not start.", Redacted.make(cause)).pipe(
		Effect.annotateLogs({ source: "startup", operation: "openbot.start" }),
	)

/**
 * Watch both failed Effects and server errors that are already mapped to responses.
 * It makes the request ids with the `Crypto` service of the program. Every log
 * of the request carries the request id of its error log, so the inside
 * failures that a request logs can be found from its error log.
 */
export const layerHttp = HttpRouter.middleware(
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto
		const records = yield* Records
		return (
			httpEffect: Effect.Effect<
				HttpServerResponse.HttpServerResponse,
				Types.unhandled
			>,
		) =>
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest
				// A platform without secure random numbers is broken, so this failure is a defect.
				const requestId = yield* crypto.randomUUIDv4().pipe(Effect.orDie)
				// The scoped form changes the context of the request in place, the
				// same way the router adds the route context. `Effect.annotateLogs`
				// puts the old context back when the handler ends, and that also
				// takes away the route context that `report` reads.
				yield* Effect.annotateLogsScoped({ requestId })
				let errorId: string | undefined
				let failure: Cause.Cause<unknown> | undefined
				const report = Effect.fnUntraced(function* (
					response: HttpServerResponse.HttpServerResponse,
					cause?: Cause.Cause<unknown>,
				) {
					if (
						errorId !== undefined ||
						response.headers[errorIdHeader] !== undefined ||
						response.status < 500 ||
						(cause !== undefined && Cause.hasInterruptsOnly(cause))
					)
						return response
					// A request that matches no route has no route context.
					const route = Context.getOption(
						yield* Effect.context<never>(),
						HttpRouter.RouteContext,
					)
					const annotations = {
						source: "http",
						operation: "http.request",
						requestId,
						method: request.method,
						route: Option.match(route, {
							onNone: () => "/unknown",
							onSome: ({ route }) => route.path,
						}),
						status: response.status,
					}
					const saved = yield* records
						.record(
							cause ??
								Cause.fail({ _tag: "HttpFailure", status: response.status }),
							"unavailable",
						)
						.pipe(Effect.annotateLogs(annotations), Effect.orDie)
					errorId = saved.errorId
					return HttpServerResponse.setHeader(response, errorIdHeader, errorId)
				})
				return yield* httpEffect.pipe(
					Effect.tapCause((cause) =>
						Effect.sync(() => {
							failure = cause
						}),
					),
					HttpEffect.withPreResponseHandler((_, response) =>
						report(response, failure),
					),
				)
			})
	}),
	{ global: true },
)

/** The reporting scope must last longer than server construction and shutdown. */
export const withStartup = <A, E, R>(program: Effect.Effect<A, E, R>) =>
	program.pipe(
		Effect.tapCause((cause) =>
			Cause.hasInterruptsOnly(cause) ? Effect.void : startup(cause),
		),
	)
