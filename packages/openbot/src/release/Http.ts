import { Effect, Layer, Option, Redacted, String as Str } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import * as Admission from "./Admission.ts"
import * as Report from "../errors/Report.ts"
import { sameSecret } from "../secrets/Compare.ts"

export const path = "/internal/execution"
const unavailable = HttpServerResponse.jsonUnsafe(
	{
		code: "unavailable",
		message: "The service is being updated. Please try again shortly.",
	},
	{ status: 503, headers: { "retry-after": "5" } },
)

/** These private routes keep the release protocol used by the deployment job. */
export const routes = (token?: Redacted.Redacted<string>) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const router = yield* HttpRouter.HttpRouter
			const gate = yield* Admission.make
			const report = yield* Report.make
			for (const [name, action] of [
				["quiesce", gate.quiesce],
				["status", gate.status],
				["resume", gate.resume],
			] as const) {
				yield* router.add(
					"POST",
					`${path}/${name}`,
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest
						if (token === undefined)
							return HttpServerResponse.empty({ status: 404 })
						if (
							!sameSecret(
								request.headers["authorization"] ?? "",
								`Bearer ${Redacted.value(token)}`,
							)
						)
							return HttpServerResponse.empty({ status: 401 })
						return yield* action.pipe(
							Effect.flatMap(HttpServerResponse.schemaJson(Admission.Status)),
							Effect.catchCause((cause) =>
								report(
									"Release state could not be changed or read.",
									cause,
								).pipe(Effect.as(unavailable)),
							),
						)
					}),
				)
			}
		}),
	)

/** Reads, private control and sign-out stay available while new public work is closed. */
export const middleware = Effect.gen(function* () {
	const gate = yield* Admission.make
	const report = yield* Report.make
	return <E, R>(
		app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
	) =>
		Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest
			const url = Option.getOrUndefined(HttpServerRequest.toURL(request))
			const pathname = url?.pathname ?? ""
			if (
				Str.startsWith("/internal/")(pathname) ||
				Str.startsWith("/auth/")(pathname) ||
				(request.method === "GET" &&
					request.headers["upgrade"] === undefined) ||
				request.method === "HEAD" ||
				request.method === "OPTIONS"
			)
				return yield* app
			const closed = yield* gate.paused.pipe(
				Effect.catchCause((cause) =>
					report("Release admission could not be read.", cause).pipe(
						Effect.as(true),
					),
				),
			)
			return closed ? unavailable : yield* app
		})
})
