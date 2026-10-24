import { Account, Authorization, Identity } from "@openbot-build/api"
import { Authorizer } from "@nmnmcc/ability"
import * as AbilityHttpApi from "@nmnmcc/ability/HttpApi"
import { Layer } from "effect"
import { policyOf } from "./Load.ts"

/**
 * The policy is loaded again for each check, with no cache. So a change to a
 * role, a member or a token works at once, on every server.
 */
const layerAuth = Authorizer.layer(Authorization.Auth, {
	principal: Identity,
	policy: (caller) => policyOf(caller, { platform: false }),
	cache: false,
})

const layerPlatformAuth = Authorizer.layer(Authorization.PlatformAuth, {
	principal: Account,
	policy: (caller) => policyOf(caller, { platform: true }),
	cache: false,
})

/** The authorizers, and the middlewares that check the annotations of each endpoint. */
export const layer = Layer.mergeAll(
	AbilityHttpApi.layer(Authorization.Authorize, Authorization.Auth),
	AbilityHttpApi.layer(
		Authorization.PlatformAuthorize,
		Authorization.PlatformAuth,
	),
).pipe(Layer.provideMerge(Layer.mergeAll(layerAuth, layerPlatformAuth)))
