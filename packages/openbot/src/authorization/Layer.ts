import { Authorization as HttpAuthorization } from "@openbot-build/api"
import { Authorization } from "@openbot-build/domain"

import { AccountCaller } from "@openbot-build/domain"
import { Authorizer } from "@nmnmcc/ability"
import * as AbilityHttpApi from "@nmnmcc/ability/HttpApi"
import { Effect, Layer, Schema } from "effect"
import { policyOf } from "./Load.ts"

/**
 * The policy is loaded again for each check, with no cache. So a change to a
 * role, a member or a token works at once, on every server.
 */
const layerAuth = Authorizer.layer(Authorization.Auth, {
	policy: (caller) =>
		Schema.decodeUnknownEffect(AccountCaller)(caller).pipe(
			Effect.flatMap((caller) => policyOf(caller, { platform: false })),
		),
})

const layerPlatformAuth = Authorizer.layer(Authorization.PlatformAuth, {
	policy: (caller) =>
		Schema.decodeUnknownEffect(AccountCaller)(caller).pipe(
			Effect.flatMap((caller) => policyOf(caller, { platform: true })),
		),
})

/** The authorizers, and the middlewares that check the annotations of each endpoint. */
export const layer = Layer.mergeAll(
	AbilityHttpApi.layer(HttpAuthorization.Authorize, Authorization.Auth),
	AbilityHttpApi.layer(
		HttpAuthorization.PlatformAuthorize,
		Authorization.PlatformAuth,
	),
).pipe(Layer.provideMerge(Layer.mergeAll(layerAuth, layerPlatformAuth)))
