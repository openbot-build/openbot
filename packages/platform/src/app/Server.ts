import type { Discovery } from "@openbot-build/protocol"
import * as AppDiscovery from "../apps/Discovery.ts"
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import { createServer as createSecureServer } from "node:https"
import { NodeHttpServer } from "@effect/platform-node"
import * as Http from "./Http.ts"
import { Layer } from "effect"
import { type Tool } from "effect/ai"
import { HttpRouter } from "effect/http"
import * as Platform from "./Platform.ts"
import * as AuthHttpHandlers from "../auth/HttpHandlers.ts"
import * as ErrorReporting from "./ErrorReporting.ts"
import type { Auth } from "../auth/Auth.ts"

export const layerApi = (options: { readonly publicOrigin: string }) =>
	Layer.mergeAll(
		Http.layerPlatform(options.publicOrigin),
		ErrorReporting.layerHttp,
		AuthHttpHandlers.layerBetterAuth,
	).pipe(Layer.provide(AuthHttpHandlers.layer(options)))
export const layer = <
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	DiscoveryError = never,
	DiscoveryServices = never,
	BuildE = never,
	BuildR = never,
>(
	options: Platform.Options<Tools, E, R, BuildE, BuildR> & {
		readonly host: string
		readonly port: number
		readonly discovery?: Layer.Layer<
			Discovery.Discovery,
			DiscoveryError,
			DiscoveryServices
		>
		readonly routes?: Layer.Layer<never, never, HttpRouter.HttpRouter | Auth>
		/** Serve HTTPS directly. In production, a proxy usually terminates TLS. */
		readonly tls?:
			{ readonly certFile: string; readonly keyFile: string } | undefined
	},
) =>
	HttpRouter.serve(
		Layer.merge(layerApi(options.auth), options.routes ?? Layer.empty),
	).pipe(
		Layer.provideMerge(Platform.layer(options)),
		Layer.provide(options.discovery ?? AppDiscovery.layerPublic),
		Layer.provideMerge(
			NodeHttpServer.layer(
				() =>
					options.tls === undefined
						? createServer()
						: createSecureServer({
								cert: readFileSync(options.tls.certFile),
								key: readFileSync(options.tls.keyFile),
							}),
				{ host: options.host, port: options.port },
			),
		),
	)
