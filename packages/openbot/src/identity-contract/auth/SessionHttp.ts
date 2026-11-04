import { AuthApi } from "@openbot-build/api"
import { Effect, Layer, Option, Redacted } from "effect"
import {
	Cookies,
	HttpEffect,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"
import { Auth } from "./Auth.ts"

export const setSessionCookies = (setCookies: ReadonlyArray<string>) =>
	HttpEffect.appendPreResponseHandler((_, response) =>
		Effect.succeed(
			HttpServerResponse.mergeCookies(
				response,
				Cookies.fromSetCookie(setCookies),
			),
		),
	)

/**
 * The session of the session cookie, if the request has one. A rejected cookie
 * counts as no cookie, so the caller must log in first.
 */
export const optionalSession = (auth: typeof Auth.Service) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		return yield* Effect.transposeOption(
			Option.map(
				Option.fromNullishOr(request.cookies[AuthApi.SessionCookie]),
				(cookie) =>
					auth
						.resolveSession(Redacted.make(cookie))
						.pipe(
							Effect.tap(({ setCookies }) => setSessionCookies(setCookies)),
						),
			),
		).pipe(Effect.catchTag("CredentialRejected", () => Effect.succeedNone))
	})

export const layerNoStore = Layer.succeed(AuthApi.NoStore, (httpEffect) =>
	httpEffect.pipe(
		HttpEffect.withPreResponseHandler((_, response) =>
			Effect.succeed(
				HttpServerResponse.setHeader(response, "cache-control", "no-store"),
			),
		),
	),
)
