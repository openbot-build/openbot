/**
 * The public entry points of the OpenBot server. Each one runs the plugin
 * host with the plugins of the preset. They give the services of the kernel,
 * such as the database pool and the settings, but no service of a plugin.
 * Work of the caller that needs a service of a plugin is a fork of the host
 * (`routes` and `startup`): it names the keys that it needs, and it lives as
 * long as these services.
 */
import { PgClient } from "@effect/sql-pg"
import { Plugin as GraftPlugin } from "@graftland/graft"
import type { Entry } from "@graftland/loader"
import {
	Array as Arr,
	type Context,
	Effect,
	type FileSystem,
	Layer,
	type Path,
	type Redacted,
} from "effect"
import { SecureRandom } from "effect/crypto"
import type { Etag, HttpPlatform, HttpRouter } from "effect/http"
import type { AppNetwork } from "@openbot-build/apps-contract/apps/AppNetwork"
import type { Probe } from "@openbot-build/apps-contract/apps/Probe"
import type { Drivers } from "@openbot-build/apps-contract/computers/Drivers"
import type { Readers } from "@openbot-build/apps-contract/vaults/Readers"
import type { Transport as MailTransport } from "@openbot-build/identity-contract/mail/Transport"
import type * as LiveBackends from "@openbot-build/models-contract/LiveBackends"
import type { Discovery, Network } from "@openbot-build/protocol"
import * as RateLimit from "@openbot-build/server-billing/RateLimit"
import type * as DomainControl from "@openbot-build/server-kernel/DomainControl"
import { HttpHost } from "@openbot-build/server-kernel/HttpHost"
import * as ErrorRecords from "@openbot-build/server-kernel/Records"
import { Settings } from "@openbot-build/server-kernel/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
import type * as HostTools from "@openbot-build/tools-contract/HostTools"
import * as Assembly from "./Assembly.ts"
import { provide } from "./HostServices.ts"
import * as Serving from "./Serving.ts"

/**
 * The services from outside of OpenBot: the drivers of the Computer
 * providers, the Live backends, the readers of the password managers, the
 * network and the check of Apps, the DNS check of domains, the public network
 * of the App Index, the discovery of Apps, and the mail transport. The models
 * that the program gives itself (`BuiltinModels` of `models-contract`) come
 * from outside too.
 */
export type Outside =
	| Drivers
	| LiveBackends.LiveBackends
	| Readers
	| Probe
	| AppNetwork
	| DomainControl.DomainControl
	| Network.PublicNetwork
	| Discovery.Discovery
	| MailTransport

/**
 * The services of the kernel that more routes may use besides the keys that
 * they inject: the router, the HTTP platform, the files, the database, the
 * settings and the rate limits.
 */
export type RouteServices =
	| HttpRouter.HttpRouter
	| Etag.Generator
	| HttpPlatform.HttpPlatform
	| FileSystem.FileSystem
	| Path.Path
	| PgClient.PgClient
	| Settings
	| RateLimit.RateLimiter

/**
 * The services of the kernel that startup work may use besides the keys that
 * it injects: the database, the settings, secure random values and the error
 * records.
 */
export type StartupServices =
	| PgClient.PgClient
	| Settings
	| SecureRandom.SecureRandom
	| ErrorRecords.Records

/**
 * The mark of `Work`. The module does not export it, so only `routes` and
 * `startup` can make a `Work`.
 */
const WorkTypeId: unique symbol = Symbol("@openbot-build/openbot/Host/Work")

/**
 * Work of the caller that runs on the host: more routes or startup work. Make
 * it with `routes` or `startup`. It is opaque: it does not show the plugin
 * that runs it.
 */
export interface Work {
	readonly [WorkTypeId]: typeof WorkTypeId
}

/** The one form of `Work`. It keeps the plugin inside this module. */
class HostWork implements Work {
	readonly [WorkTypeId]: typeof WorkTypeId = WorkTypeId
	readonly plugin: GraftPlugin.Plugin
	constructor(plugin: GraftPlugin.Plugin) {
		this.plugin = plugin
	}
}

/**
 * The plugin of a `Work`. Only `routes` and `startup` make a `Work`, so every
 * value is a `HostWork`.
 */
const pluginOf = (work: Work): ReadonlyArray<GraftPlugin.Plugin> =>
	work instanceof HostWork ? [work.plugin] : []

/**
 * The keys of the kernel that the forks of `routes` and `startup` read. The
 * host gives them to every fork, so they are always there.
 */
const hostKeys = {
	routes: [PgClient.PgClient, Settings, RateLimit.RateLimiter],
	startup: [
		PgClient.PgClient,
		Settings,
		SecureRandom.SecureRandom,
		ErrorRecords.Records,
	],
} as const

/** The services that a list of keys gives. */
type Given<Keys extends ReadonlyArray<Context.Key<any, any>>> =
	Keys[number]["Identifier"]

/**
 * More routes, such as the routes of the development tools. They come last,
 * so they cannot take a route of OpenBot. `inject` names the services of
 * plugins that they need, such as `Auth` or `Wallets.Wallets`. The routes are
 * a fork of the host with this name: it mounts them when every key is
 * published, and it closes them and mounts them again when a plugin that
 * publishes one of these keys restarts. When a key is never published, for
 * example because its plugin is off, the host does not start.
 */
export const routes = <
	const Keys extends ReadonlyArray<Context.Key<any, any>>,
>(options: {
	readonly name: string
	readonly inject: Keys
	readonly layer: Layer.Layer<never, never, Given<Keys> | RouteServices>
}): Work =>
	new HostWork(
		GraftPlugin.make({
			name: `openbot.routes.${options.name}`,
			inject: [HttpHost, ...hostKeys.routes, ...options.inject] as const,
			retry: Feature.retry,
			apply: () =>
				Effect.flatMap(HttpHost, (host) =>
					host.mountRoutes(`routes.${options.name}`, options.layer, {
						last: true,
					}),
				).pipe(
					// Each name has one mount, so a conflict is a broken rule of the caller.
					Effect.catchTag("MountConflict", Effect.die),
				),
		}),
	)

/**
 * Work that runs when the server starts, such as indexing the development
 * App. `inject` names the services of plugins that it needs. The work is a
 * fork of the host with this name: it builds the layer when every key is
 * published, and it closes the layer and builds it again when a plugin that
 * publishes one of these keys restarts. When a key is never published, the
 * host does not start.
 */
export const startup = <
	const Keys extends ReadonlyArray<Context.Key<any, any>>,
>(options: {
	readonly name: string
	readonly inject: Keys
	readonly layer: Layer.Layer<never, never, Given<Keys> | StartupServices>
}): Work =>
	new HostWork(
		GraftPlugin.make({
			name: `openbot.startup.${options.name}`,
			inject: [...hostKeys.startup, ...options.inject] as const,
			retry: Feature.retry,
			apply: () => Layer.build(options.layer).pipe(Effect.asVoid),
		}),
	)

/**
 * The settings of the app. They are plain values, and layers of the caller.
 * `E` and `R` are the errors and the needed services of the `outside` Layer.
 * They go into the type of the server Layer. `O` is what the `outside` Layer
 * gives.
 */
export interface AppOptions<E = never, R = never, O extends Outside = never> {
	readonly databaseUrl: Redacted.Redacted<string>
	/** `OPENBOT_SECRET_KEYS`, such as `k2:<hex>,k1:<hex>`. The first key encrypts. */
	readonly secretKeys: Redacted.Redacted<string>
	/** The same private RPC secret on every node. */
	readonly clusterSecret: Redacted.Redacted<string>
	/** The address that other nodes can reach. Defaults to the bound server address. */
	readonly clusterHost?: string | undefined
	/** The entries of the loader. The default is `Preset.entries`. */
	readonly entries?: ReadonlyArray<Entry.Entry> | undefined
	/**
	 * More plugins that the entries can name, such as the plugins of a test.
	 * The plugins of the preset win over them.
	 */
	readonly plugins?: Readonly<Record<string, GraftPlugin.Plugin>> | undefined
	/**
	 * The path of the plugins file (`OPENBOT_PLUGINS_FILE`). The host reads it
	 * one time, when it starts. It never writes the file.
	 */
	readonly pluginsFile?: string | undefined
	/** The tools that the host gives to every Bot. The default is none. */
	readonly hostTools?: Layer.Layer<HostTools.HostTools> | undefined
	/**
	 * Services from outside of OpenBot that take the place of the real ones,
	 * such as fakes in a test. Every service that this Layer does not give is
	 * the real one, which uses the network of the process with the address
	 * rule of the outbound guard. Its errors and the services that it needs go
	 * into the type of the server Layer.
	 */
	readonly outside?: Layer.Layer<O, E, R> | undefined
	/** More routes and startup work. Make each one with `routes` or `startup`. */
	readonly work?: ReadonlyArray<Work> | undefined
}

/**
 * The settings of a server. Without `auth`, sign-in follows the platform
 * settings that `openbot setup` writes. With `auth`, the server writes this
 * one sign-in configuration into the platform settings when it starts. An
 * `auth` in development mode uses the local test account.
 */
export interface Options<E = never, R = never, O extends Outside = never>
	extends AppOptions<E, R, O>, Serving.Listen, Partial<Serving.Fixed> {}

const app = (
	options: Omit<AppOptions, "outside" | "hostTools">,
	development: boolean,
) =>
	Assembly.layerApp({
		...options,
		development,
		work: Arr.flatMap(options.work ?? [], pluginOf),
	})

/**
 * Serves OpenBot with its own Node.js HTTP server. Every route except
 * `/health` answers with SetupRequired while the platform has no settings.
 * Without `auth`, the server warns when the platform has no settings. It
 * needs only the platform services (`Launch.Platform`). A failed start fails
 * the Layer with a `Launch.StartFailed`.
 */
export const layer = <E = never, R = never, O extends Outside = never>(
	options: Options<E, R, O>,
) => {
	const auth = options.auth
	const before: Layer.Layer<
		never,
		Layer.Error<ReturnType<typeof Serving.fixed>>,
		| Layer.Services<ReturnType<typeof Serving.fixed>>
		| Layer.Services<typeof Serving.warnBeforeSetup>
	> = auth === undefined
		? Serving.warnBeforeSetup
		: Serving.fixed({ ...options, auth })
	return Serving.serve(app(options, auth?.mode === "development")).pipe(
		Layer.provide(before),
		Layer.provideMerge(Serving.nodeServer(options)),
		provide(options),
	)
}

/**
 * The routes and services of OpenBot, for a caller that serves them with its
 * own HTTP server, such as `HttpRouter.serve(Host.layerApp(options))`. It has
 * no check of the platform settings. It needs the platform services, the HTTP
 * server and the router.
 */
export const layerApp = <E = never, R = never, O extends Outside = never>(
	options: AppOptions<E, R, O>,
) => app(options, false).pipe(provide(options))
