import { Redacted } from "effect"
import { AuthApi } from "@openbot-build/api"

/** Call the API as a signed-in browser on the public origin. */
export const withCookie =
	({
		address,
		publicOrigin,
	}: {
		readonly address: string
		readonly publicOrigin: string
	}) =>
	(
		credential: Redacted.Redacted<string>,
		path: string,
		method = "GET",
		payload?: unknown,
	) =>
		fetch(address + path, {
			method,
			headers: {
				cookie:
					AuthApi.SessionCookie +
					"=" +
					encodeURIComponent(Redacted.value(credential)),
				origin: publicOrigin,
				...(payload === undefined
					? {}
					: { "content-type": "application/json" }),
			},
			...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
		})

/** Call the API as a program with a user token. */
export const withToken =
	(address: string) =>
	(secret: string, path: string, method = "GET", payload?: unknown) =>
		fetch(address + path, {
			method,
			headers: {
				authorization: "Bearer " + secret,
				...(payload === undefined
					? {}
					: { "content-type": "application/json" }),
			},
			...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
		})
