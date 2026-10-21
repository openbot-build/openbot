import { randomUUID } from "node:crypto"
import { Cause, Effect, Match, Option } from "effect"
import type { Turn } from "@openbot-build/core"
import { HttpEffect, HttpRouter, HttpServerRequest } from "effect/http"

interface Failure {
	readonly source: "http" | "turn" | "startup"
	readonly operation: string
	readonly cause?: Cause.Cause<unknown>
	readonly errorType?: string
	readonly sessionId?: string
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
		"Platform operation failed",
		...(cause === undefined ? [] : [cause]),
	).pipe(Effect.annotateLogs(annotations))

export const failedTurn = (turn: Turn.Record): Effect.Effect<void> =>
	Match.value(turn.status).pipe(
		Match.tag("Failed", (status) =>
			record({
				source: "turn",
				operation: "turn.execute",
				sessionId: turn.session,
				turnId: turn.id,
				errorType: status.code,
				cause: Cause.fail(status),
			}),
		),
		Match.orElse(() => Effect.void),
	)

/** Watch both failed Effects and server errors that are already mapped to responses. */
export const layerHttp = HttpRouter.middleware(
	(httpEffect) =>
		Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest
			const requestId = randomUUID()
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
					...(cause === undefined ? { errorType: `Http${status}` } : { cause }),
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
		}),
	{ global: true },
)

/** The reporting scope must last longer than server construction and shutdown. */
export const withStartup = <A, E, R>(program: Effect.Effect<A, E, R>) =>
	program.pipe(
		Effect.tapCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.void
				: record({ source: "startup", operation: "platform.start", cause }),
		),
	)
