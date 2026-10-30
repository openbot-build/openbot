/** Public HTTP integration for hosts that sell OpenBot credits. */
export * as Api from "@openbot-build/api"
export { Wallets, layer } from "../billing/Host.ts"
import { Layer } from "effect"
import * as Authentication from "../auth/HttpMiddleware.ts"
import * as Authorization from "../authorization/Layer.ts"
export const middleware = Layer.mergeAll(
	Authentication.layerBotAuth,
	Authentication.layerNoStore,
	Authorization.layer,
)
