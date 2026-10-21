import type { Discovery } from "@openbot-build/protocol"
import * as AppDiscovery from "../apps/Discovery.ts"
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import { createServer as createSecureServer } from "node:https"
import { NodeHttpServer } from "@effect/platform-node"
import * as Http from "./Http.ts"
import { Effect, Layer, Option, Redacted } from "effect"
import { type Tool } from "effect/ai"
import { HttpRouter } from "effect/http"
import * as OpenBot from "./OpenBot.ts"
import * as AuthHttpHandlers from "../auth/HttpHandlers.ts"
import * as ErrorReporting from "./ErrorReporting.ts"
import * as Supervisor from "./Supervisor.ts"
import * as PlatformAdminsPostgres from "../platform/PlatformAdminsPostgres.ts"
import * as Setup from "../platform/Setup.ts"
import type { Auth } from "../auth/Auth.ts"
import type { Configuration } from "../auth/Model.ts"
import type { IndexWork } from "../apps/IndexWork.ts"
import type { IndexWorkRepository } from "../apps/IndexWorkRepository.ts"

export const layerApi = (options: { readonly publicOrigin: string }) =>
	Layer.mergeAll(
		Http.layerPlatform(options.publicOrigin),
		ErrorReporting.layerHttp,
		AuthHttpHandlers.layerBetterAuth,
	).pipe(Layer.provide(AuthHttpHandlers.layer(options)))

export type AppOptions<
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	BuildE = never,
	BuildR = never,
	DiscoveryError = never,
	DiscoveryServices = never,
> = Omit<OpenBot.Options<Tools, E, R, BuildE, BuildR>, "auth"> & {
	readonly discovery?: Layer.Layer<
		Discovery.Discovery,
		DiscoveryError,
		DiscoveryServices
	>
	/** Work that runs each time an app starts, such as indexing the development App. */
	readonly startup?: Layer.Layer<never, never, IndexWork | IndexWorkRepository>
	/** More routes, such as the routes of the development tools. */
	readonly routes?: (
		auth: Configuration,
	) => Layer.Layer<never, never, HttpRouter.HttpRouter | Auth>
}

/** The routes and services of one platform configuration. */
export const layerApp =
	<
		Tools extends Record<string, Tool.Any> = {},
		E = never,
		R = never,
		BuildE = never,
		BuildR = never,
		DiscoveryError = never,
		DiscoveryServices = never,
	>(
		options: AppOptions<
			Tools,
			E,
			R,
			BuildE,
			BuildR,
			DiscoveryError,
			DiscoveryServices
		>,
	) =>
	(auth: Configuration) =>
		Layer.mergeAll(
			layerApi(auth),
			options.routes?.(auth) ?? Layer.empty,
			options.startup ?? Layer.empty,
		).pipe(
			Layer.provideMerge(OpenBot.layer({ ...options, auth })),
			Layer.provideMerge(options.discovery ?? AppDiscovery.layerPublic),
		)

const nodeServer = (options: {
	readonly host: string
	readonly port: number
	readonly tls?:
		{ readonly certFile: string; readonly keyFile: string } | undefined
}) =>
	NodeHttpServer.layer(
		() =>
			options.tls === undefined
				? createServer()
				: createSecureServer({
						cert: readFileSync(options.tls.certFile),
						key: readFileSync(options.tls.keyFile),
					}),
		{ host: options.host, port: options.port },
	)

/**
 * Serves one fixed sign-in configuration, without the supervisor, and gives
 * the app services to the caller. Tests use it to reach those services.
 * It writes platform settings for the public origin first, when there are none.
 */
export const layerFixed = <
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	DiscoveryError = never,
	DiscoveryServices = never,
	BuildE = never,
	BuildR = never,
>(
	options: AppOptions<
		Tools,
		E,
		R,
		BuildE,
		BuildR,
		DiscoveryError,
		DiscoveryServices
	> & {
		readonly host: string
		readonly port: number
		readonly secretKeys: Redacted.Redacted<string>
		readonly auth: Configuration
		/** The platform admins of a new platform. */
		readonly platformAdmins?: ReadonlyArray<string>
		/** Write the public origin even when the platform has other settings. */
		readonly force?: boolean
		readonly tls?:
			{ readonly certFile: string; readonly keyFile: string } | undefined
	},
) =>
	HttpRouter.serve(layerApp(options)(options.auth)).pipe(
		// Routes get the services that they ask for from outside the router.
		Layer.provide(options.discovery ?? AppDiscovery.layerPublic),
		Layer.provide(
			Layer.effectDiscard(
				Setup.run({
					publicOrigin: options.auth.publicOrigin,
					identityProvider: Option.none(),
					adminEmails: options.platformAdmins ?? ["developer@localhost.test"],
					force: options.force === true,
					// The settings then describe the app that this layer serves.
					authSecret: Redacted.value(options.auth.secret),
				}).pipe(Effect.orDie),
			).pipe(Layer.provide(PlatformAdminsPostgres.layer)),
		),
		Layer.provideMerge(OpenBot.layerShared(options)),
		Layer.provideMerge(nodeServer(options)),
	)

export const layer = <
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	DiscoveryError = never,
	DiscoveryServices = never,
	BuildE = never,
	BuildR = never,
>(
	options: AppOptions<
		Tools,
		E,
		R,
		BuildE,
		BuildR,
		DiscoveryError,
		DiscoveryServices
	> & {
		readonly host: string
		readonly port: number
		readonly secretKeys: Redacted.Redacted<string>
		/** Use the local test account instead of a sign-in provider. */
		readonly development?: boolean
		/** Serve HTTPS directly. In production, a proxy usually terminates TLS. */
		readonly tls?:
			{ readonly certFile: string; readonly keyFile: string } | undefined
	},
) =>
	Supervisor.layer({
		development: options.development === true,
		app: layerApp(options),
	}).pipe(
		Layer.provideMerge(OpenBot.layerShared(options)),
		Layer.provideMerge(nodeServer(options)),
	)
