import { Authorization, FailureApi } from "@openbot-build/api"
import { Effect, Layer } from "effect"
import { HttpHost } from "@openbot-build/server-kernel/HttpHost"
import * as AuthHandlers from "./HttpHandlers.ts"

/**
 * The keys of the HTTP contract and of the host that the mounts of this
 * plugin need. The plugin lists them in the `inject` of its start.
 */
export const inject = [
	HttpHost,
	FailureApi.FailureBoundary,
	Authorization.Authorize,
] as const

/** Serves the groups of this plugin until the scope closes. */
export const mount = Effect.flatMap(HttpHost, (host) =>
	host.mount(["account", "userTokens", "signIn"], AuthHandlers.layerGroups),
)

/**
 * Serves the routes of Better Auth under `/auth` until the scope closes. A
 * contract route always wins over them.
 */
export const mountBetterAuth = Effect.flatMap(HttpHost, (host) =>
	host.mountRoutes("better-auth", AuthHandlers.layerBetterAuth),
)

/** `mount` and `mountBetterAuth` as a layer. A mount conflict fails the plugin. */
export const layer = Layer.effectDiscard(Effect.andThen(mount, mountBetterAuth))
