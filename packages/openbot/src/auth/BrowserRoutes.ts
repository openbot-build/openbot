import { ReturnTo } from "@openbot-build/domain"
import { Array as Arr, Effect, Schema } from "effect"

interface BrowserAuth {
	readonly handler: (request: Request) => Promise<Response>
	readonly signIn: (returnTo: string, headers: Headers) => Promise<Response>
	readonly signOut: (headers: Headers) => Promise<Response>
}

/** Stable browser routes. Cookies and OAuth state remain owned by Better Auth. */
export const handler =
	(
		config: {
			readonly publicOrigin: string
			readonly providerId?: string
			readonly callbackPath?: string
		},
		auth: BrowserAuth,
	) =>
	(request: Request) =>
		Effect.gen(function* () {
			const url = new URL(request.url)
			if (url.pathname === "/auth/login" && request.method === "GET") {
				const target = url.searchParams.get("returnTo") ?? "/"
				if (
					url.searchParams.getAll("returnTo").length > 1 ||
					!Schema.is(ReturnTo)(target)
				)
					return new Response(null, { status: 400 })
				const response = yield* Effect.promise(() =>
					auth.signIn(target, request.headers),
				)
				if (!response.ok || !response.headers.has("location"))
					return new Response(null, { status: 503 })
				return new Response(null, { status: 303, headers: response.headers })
			}
			if (
				(url.pathname === "/auth/callback" ||
					(url.pathname === config.callbackPath &&
						config.callbackPath !== "/auth/callback/" + config.providerId)) &&
				request.method === "GET"
			) {
				if (
					config.providerId === undefined ||
					Arr.some(
						[...url.searchParams.keys()],
						(key) => url.searchParams.getAll(key).length !== 1,
					)
				)
					return new Response(null, { status: 400 })
				const callback = new URL(config.publicOrigin)
				callback.pathname = "/auth/callback/" + config.providerId
				callback.search = url.search
				const response = yield* Effect.promise(() =>
					auth.handler(
						new Request(callback, {
							headers: request.headers,
							signal: request.signal,
						}),
					),
				)
				const location = response.headers.get("location")
				const error =
					location === null
						? null
						: new URL(location, config.publicOrigin).searchParams.get("error")
				const status =
					response.status >= 400
						? response.status >= 500
							? 503
							: 400
						: location === null
							? 503
							: error === null
								? 303
								: error === "oauth_provider_not_found"
									? 503
									: 401
				return new Response(null, { status, headers: response.headers })
			}
			if (url.pathname === "/auth/logout" && request.method === "POST") {
				if (request.headers.get("origin") !== config.publicOrigin)
					return new Response(null, { status: 403 })
				const response = yield* Effect.promise(() =>
					auth.signOut(request.headers),
				)
				return new Response(null, {
					status: response.ok ? 204 : 503,
					headers: response.headers,
				})
			}
			return yield* Effect.promise(() => auth.handler(request))
		})
