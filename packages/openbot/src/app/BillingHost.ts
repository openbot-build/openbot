/** Public HTTP integration for hosts that sell OpenBot credits. */
export * as Api from "@openbot-build/api"
export { Wallets, layer } from "../server-billing/billing/Host.ts"
import { Layer } from "effect"
import * as Authentication from "../plugin-auth/HttpMiddleware.ts"
import * as Authorization from "../plugin-authorization/Layer.ts"
export const middleware = Layer.mergeAll(
	Authentication.layerBotAuth,
	Authentication.layerNoStore,
	Authorization.layer,
)
