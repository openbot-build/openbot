/**
 * The public entry points of the OpenBot server. Each one runs the plugin
 * host with every plugin of the preset, and gives a snapshot of the services
 * that the plugins publish.
 */
import { Layer, type Redacted } from "effect"
import type { HttpClient } from "effect/http"
import type * as ErrorRecords from "../server-kernel/errors/Records.ts"
import * as HostTools from "../tools-contract/chats/HostTools.ts"
import * as Assembly from "./Assembly.ts"
import * as Outside_ from "./Outside.ts"
import * as Shared from "./Shared.ts"

/**
 * The services from outside of OpenBot: the drivers of the Computer
 * providers, the Live backends, the readers of the password managers, the
 * network and the check of Apps, the DNS check of domains, the public network
 * of the App Index, and the discovery of Apps.
 */
export type Outside = Outside_.Services

/** What startup work may use. */
export type StartupServices = Assembly.StartupServices

/**
 * What more routes may use: the router, the platform, the database, the
 * settings, the sign-in check (`Auth`), the credit operations (`Wallets`),
 * and the services that the authentication and authorization middleware of
 * the contract need.
 */
export type RouteServices = Assembly.RouteServices

/**
 * The settings of the app. They are plain values, and layers of the caller.
 * `E` and `R` are the errors and the needed services of the `outside` Layer.
 * They go into the type of the server Layer.
 */
export interface AppOptions<E = never, R = never> extends Omit<
	Assembly.AppOptions,
	"development" | "indexNamespace"
> {
	/** `OPENBOT_SECRET_KEYS`, such as `k2:<hex>,k1:<hex>`. The first key encrypts. */
	readonly secretKeys: Redacted.Redacted<string>
	/** The tools that the host gives to every Bot. The default is none. */
	readonly hostTools?: Layer.Layer<HostTools.HostTools> | undefined
	/**
	 * The services from outside of OpenBot. The default uses the network of
	 * the process, with the address rule of the outbound guard. A test can
	 * give fakes here. Its errors and the services that it needs go into the
	 * type of the server Layer.
	 */
	readonly outside?: Layer.Layer<Outside, E, R> | undefined
}

/**
 * The settings of a server. Without `auth`, sign-in follows the platform
 * settings that `openbot setup` writes. With `auth`, the server writes this
 * one sign-in configuration into the platform settings when it starts.
 */
export interface Options<E = never, R = never>
	extends
		AppOptions<E, R>,
		Omit<Assembly.ServerOptions, keyof Assembly.AppOptions> {}

/** The services from outside, the tools of the host, and the shared services. */
const provide = <OE, OR>(options: AppOptions<OE, OR>) => {
	const outside: Layer.Layer<
		Outside,
		OE,
		OR | HttpClient.HttpClient | ErrorRecords.Records
	> = options.outside ?? Outside_.layer
	return <A, E, R>(app: Layer.Layer<A, E, R>) =>
		app.pipe(
			Layer.provide(Layer.merge(outside, options.hostTools ?? HostTools.none)),
			Layer.provideMerge(Shared.layer(options)),
		)
}

/**
 * Serves OpenBot with its own Node.js HTTP server. Every route except
 * `/health` answers with SetupRequired while the platform has no settings.
 * The `openbot-server` program runs `Launch.main(Host.layer)`. It needs only
 * the platform services (`Launch.Platform`).
 */
export const layer = <E = never, R = never>(options: Options<E, R>) =>
	provide(options)(Assembly.layerServer(options))

/**
 * The routes and services of OpenBot, for a caller that serves them with its
 * own HTTP server, such as `HttpRouter.serve(Host.layerApp(options))`. It has
 * no check of the platform settings. It needs the platform services, the HTTP
 * server and the router.
 */
export const layerApp = <E = never, R = never>(options: AppOptions<E, R>) =>
	provide(options)(Assembly.layerApp(options))
