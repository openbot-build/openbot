import { assert } from "@effect/vitest"
import { AuthApi } from "@openbot-build/api"
import { Effect, Redacted } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import * as Caller from "./Caller.ts"
import type { Send } from "./Messages.ts"
import * as Organizations from "./Organizations.ts"

/** Calls a development server as a browser with the session Cookie. */
export const browser = (
	address: string,
	publicOrigin: string,
	credential: Redacted.Redacted<string>,
): Send => {
	const call = Caller.withCookie({ address, publicOrigin })
	return (path, method, payload) => call(credential, path, method, payload)
}

/**
 * Signs in to a development server, and makes the organization of the
 * account. It gives the session Cookie as a credential and as a header value,
 * and a sender that calls the server as the signed-in browser.
 */
export const signIn = Effect.fn("DevelopmentLogin.signIn")(function* (
	address: string,
	publicOrigin: string,
) {
	const login = yield* HttpClientRequest.post(
		address + "/auth/development/sign-in",
		{ headers: { origin: publicOrigin } },
	).pipe(HttpClientRequest.bodyJson({}), Effect.flatMap(HttpClient.execute))
	assert.strictEqual(login.status, 200)
	const session = yield* Effect.fromOption(
		Cookies.get(login.cookies, AuthApi.SessionCookie),
	)
	const credential = Redacted.make(session.value)
	const send = browser(address, publicOrigin, credential)
	yield* Organizations.ensure(send)
	return {
		credential,
		cookie: session.name + "=" + session.valueEncoded,
		send,
	}
})
