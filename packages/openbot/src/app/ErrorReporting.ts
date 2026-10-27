import { Cause, Crypto, Effect, Match, Option, type Types } from "effect"
import type { Turn } from "@openbot-build/core"
import {
	HttpEffect,
	HttpRouter,
	HttpServerRequest,
	type HttpServerResponse,
} from "effect/http"

interface Failure {
	readonly source: "http" | "turn" | "startup"
	readonly operation: string
	readonly cause?: Cause.Cause<unknown>
	readonly errorType?: string
	readonly chatId?: string
	readonly turnId?: string
	readonly requestId?: string
	readonly method?: string
	readonly route?: string
	readonly status?: number
}

/** Logs an operation failure without changing its result or error channel. */
export const record = ({
	cause,
	...annotations
}: Failure): Effect.Effect<void> =>
	Effect.logError(
		"OpenBot operation failed",
		...(cause === undefined ? [] : [cause]),
	).pipe(Effect.annotateLogs(annotations))

export const failedTurn = (turn: Turn.Record): Effect.Effect<void> =>
	Match.value(turn.status).pipe(
		Match.tag("Failed", (status) =>
			record({
				source: "turn",
				operation: "turn.execute",
				chatId: turn.chat,
				turnId: turn.id,
				errorType: status.code,
				cause: Cause.fail(status),
			}),
		),
		Match.orElse(() => Effect.void),
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
				let reported = false
				let failure: Cause.Cause<unknown> | undefined
				const report = Effect.fnUntraced(function* (
					status: number,
					cause?: Cause.Cause<unknown>,
				) {
					if (
						reported ||
						status < 500 ||
						(cause !== undefined && Cause.hasInterruptsOnly(cause))
					)
						return
					reported = true
					// A request that matches no route has no route context.
					const route = yield* Effect.serviceOption(HttpRouter.RouteContext)
					yield* record({
						source: "http",
						operation: "http.request",
						requestId,
						method: request.method,
						route: Option.match(route, {
							onNone: () => "/unknown",
							onSome: ({ route }) => route.path,
						}),
						status,
						...(cause === undefined
							? { errorType: `Http${status}` }
							: { cause }),
					})
				})
				return yield* httpEffect.pipe(
					Effect.tapCause((cause) =>
						Effect.sync(() => {
							failure = cause
						}),
					),
					HttpEffect.withPreResponseHandler((_, response) =>
						report(response.status, failure).pipe(Effect.as(response)),
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
			Cause.hasInterruptsOnly(cause)
				? Effect.void
				: record({ source: "startup", operation: "openbot.start", cause }),
		),
	)
