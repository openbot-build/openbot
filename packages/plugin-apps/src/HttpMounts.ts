import { AuthApi, Authorization, FailureApi } from "@openbot-build/api"
import { Effect, Layer } from "effect"
import { HttpHost } from "@openbot-build/server-kernel/HttpHost"
import * as AppAuthorizationHandlers from "./AuthorizationHttpHandlers.ts"
import * as AppExperienceHandlers from "./ExperienceHttpHandlers.ts"
import * as AppHandlers from "./HttpHandlers.ts"
import * as AppToolHandlers from "./OperationHttpHandlers.ts"
import * as AppViewHandlers from "./ViewHttpHandlers.ts"
import * as ConnectionHandlers from "./ConnectionHttpHandlers.ts"
import * as DeveloperHandlers from "./DeveloperHttpHandlers.ts"
import * as IndexHandlers from "./IndexHttpHandlers.ts"

/**
 * The keys of the HTTP contract and of the host that the mounts of this
 * plugin need. The plugin lists them in the `inject` of its start.
 */
export const inject = [
	HttpHost,
	FailureApi.FailureBoundary,
	AuthApi.BotAuth,
	AuthApi.NoStore,
	Authorization.Authorize,
] as const

/** Serves the groups of this plugin until the scope closes. */
export const mount = Effect.flatMap(HttpHost, (host) =>
	host.mount(
		[
			"developerPublic",
			"developer",
			"apps",
			"appOperations",
			"appViews",
			"appExperience",
			"appIndex",
			"appAuthorization",
			"appAuthorizationPublic",
			"connections",
		],
		Layer.mergeAll(
			DeveloperHandlers.layerPublic,
			DeveloperHandlers.layer,
			AppHandlers.layer,
			AppToolHandlers.layer,
			AppViewHandlers.layer,
			AppExperienceHandlers.layer,
			IndexHandlers.layer,
			AppAuthorizationHandlers.layer,
			ConnectionHandlers.layer,
		),
	),
)

/** `mount` as a layer. A mount conflict fails the plugin. */
export const layer = Layer.effectDiscard(mount)
