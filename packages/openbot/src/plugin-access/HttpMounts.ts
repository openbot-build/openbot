import { AuthApi, Authorization, FailureApi } from "@openbot-build/api"
import { Effect, Layer } from "effect"
import { HttpHost } from "../server-kernel/errors/HttpHost.ts"
import * as AccessHandlers from "./HttpHandlers.ts"

/**
 * The keys of the HTTP contract and of the host that the mounts of this
 * plugin need. The plugin lists them in the `inject` of its start.
 */
export const inject = [
	HttpHost,
	FailureApi.FailureBoundary,
	AuthApi.AccountAuth,
	AuthApi.NoStore,
	AuthApi.OriginCheck,
	Authorization.PlatformAuthorize,
] as const

/** Serves the groups of this plugin until the scope closes. */
export const mount = Effect.flatMap(HttpHost, (host) =>
	host.mount(["access", "loginOptions", "emailSignIn"], AccessHandlers.layer),
)

/** `mount` as a layer. A mount conflict fails the plugin. */
export const layer = Layer.effectDiscard(mount)
