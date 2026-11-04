/**
 * How the parts of OpenBot come together on the graft host. The kernel gives
 * the services that every plugin shares. The loader runs the plugins of the
 * preset on top of it. Startup waits until every plugin is active, then opens
 * the first engine generation.
 *
 * This module is private. `Host` gives the public entry points. The
 * development server and the tests use the parts here, because they give
 * their own services from outside.
 */
import { Graft, type Plugin as GraftPlugin } from "@graftland/graft"
import { type Entry, Loader, ModuleResolver } from "@graftland/loader"
import { NodeHttpClient, type NodeServices } from "@effect/platform-node"
import type { PgClient } from "@effect/sql-pg"
import { Context, Effect, Layer, Option, type Redacted, Stream } from "effect"
import { RunnerAddress, ShardingConfig } from "effect/cluster"
import type { SecureRandom } from "effect/crypto"
import {
	type Etag,
	HttpClient,
	type HttpPlatform,
	type HttpRouter,
	HttpServer,
} from "effect/http"
import { NetAddress } from "effect/net"
import { IndexNamespace } from "../apps-contract/apps/IndexNamespace.ts"
import type { IndexWork as IndexWorkService } from "../apps-contract/apps/IndexWork.ts"
import * as BotFeatures from "../conversation-contract/chats/BotFeatures.ts"
import type { Auth } from "../identity-contract/auth/Auth.ts"
import type { Tokens } from "../identity-contract/auth/Tokens.ts"
import type { Roles } from "../identity-contract/authorization/Roles.ts"
import type { Transport as MailTransport } from "../identity-contract/mail/Transport.ts"
import type { Organization } from "../identity-contract/organization/Organization.ts"
import type { PlatformAdmins } from "../identity-contract/platform/PlatformAdmins.ts"
import type * as AppIndex from "../plugin-apps/Index.ts"
import type * as IndexWork from "../plugin-apps/IndexWork.ts"
import * as AppWiring from "../plugin-apps/Wiring.ts"
import * as MailSmtp from "../plugin-mail/Smtp.ts"
import type * as ModelRegistry from "../plugin-models/ModelRegistry.ts"
import * as ModelWiring from "../plugin-models/Wiring.ts"
import * as BillingPostgres from "../server-billing/billing/BillingPostgres.ts"
import type { Wallets } from "../server-billing/billing/Host.ts"
import * as RateLimit from "../server-billing/billing/RateLimit.ts"
import * as TokenThrottle from "../server-billing/billing/TokenThrottle.ts"
import * as Calls from "../server-execution/execution/Calls.ts"
import * as ExecutionCommands from "../server-execution/execution/Commands.ts"
import * as ExecutionEngine from "../server-execution/execution/Engine.ts"
import * as EngineHost from "../server-execution/execution/EngineHost.ts"
import * as ExecutionObservation from "../server-execution/execution/Observation.ts"
import * as Runner from "../server-execution/execution/Runner.ts"
import * as RunScope from "../server-execution/execution/RunScope.ts"
import * as Send from "../server-execution/execution/Send.ts"
import * as ExecutionStore from "../server-execution/execution/Store.ts"
import * as Workflows from "../server-execution/execution/Workflows.ts"
import * as ConnectionScopes from "../server-execution/resources/ConnectionScopes.ts"
import * as ResourceDirectory from "../server-execution/resources/Directory.ts"
import * as ResourceTransport from "../server-execution/resources/Transport.ts"
import * as PrivateRpc from "../server-execution/transport/PrivateRpc.ts"
import { InstanceSettings } from "../server-kernel/configuration/InstanceSettings.ts"
import * as HttpFailureBoundary from "../server-kernel/errors/HttpBoundary.ts"
import * as HttpHost from "../server-kernel/errors/HttpHost.ts"
import * as ErrorRecords from "../server-kernel/errors/Records.ts"
import * as ErrorReporting from "../server-kernel/errors/Reporting.ts"
import type { Settings } from "../server-kernel/settings/Settings.ts"
import * as Capture from "./Capture.ts"
import * as Composition from "./Composition.ts"
import * as HostPlugins from "./HostPlugins.ts"
import * as Http from "./Http.ts"
import * as PluginFailures from "./PluginFailures.ts"
import * as PluginLogs from "./PluginLogs.ts"
import * as PresetPlugins from "./PresetPlugins.ts"
import * as Serving from "./Serving.ts"

/** The settings of the host. They are plain values. */
export interface Options {
	readonly databaseUrl: Redacted.Redacted<string>
	/** The same private RPC secret on every node. */
	readonly clusterSecret: Redacted.Redacted<string>
	/** The address that other nodes can reach. Defaults to the bound server address. */
	readonly clusterHost?: string | undefined
	/** An outside mail service for tests or a host. The default uses SMTP. */
	readonly mailTransport?: Layer.Layer<MailTransport>
	/**
	 * Use the local test account instead of a sign-in provider. The public
	 * origin and the sign-in secret still come from the platform settings.
	 */
	readonly development?: boolean
	readonly indexNamespace?: "public" | "development"
	readonly indexWork?: IndexWork.Options
	readonly indexSources?: ReadonlyArray<AppIndex.SourceProvider>
	/**
	 * Models that the program gives itself, such as the simulated models of
	 * development or of a test. Every organization can use them. All other
	 * models come from the model providers that the API stores.
	 */
	readonly builtinModels?: ModelRegistry.Builtin
	/** The entries of the loader. The default is `PresetPlugins.entries`. */
	readonly entries?: ReadonlyArray<Entry.Entry> | undefined
	/**
	 * More plugins that the entries can name, such as the plugins of a test.
	 * The plugins of `PresetPlugins.plugins` win over them.
	 */
	readonly plugins?: Readonly<Record<string, GraftPlugin.Plugin>> | undefined
}

/**
 * The services of the execution engine that every node shares. The bound
 * port also works when a test asks for a free port with port 0.
 */
const executionServices = (options: {
	readonly clusterSecret: Redacted.Redacted<string>
	readonly clusterHost?: string | undefined
}) => {
	const config = Layer.unwrap(
		Effect.gen(function* () {
			const server = yield* HttpServer.HttpServer
			if (server.address._tag === "UnixPathAddress")
				return yield* Effect.die("Cluster RPC needs a TCP server.")
			return ShardingConfig.layer({
				runnerAddress: Option.some(
					RunnerAddress.make(
						options.clusterHost ?? NetAddress.formatHost(server.address),
						server.address.port,
					),
				),
			})
		}),
	)
	return Layer.mergeAll(
		ExecutionCommands.layer,
		Send.layer,
		ResourceTransport.layer.pipe(
			Layer.provideMerge(
				ResourceDirectory.layer.pipe(
					Layer.provide(ExecutionEngine.layerRunnerList),
				),
			),
			Layer.provide(NodeHttpClient.layerUndici),
		),
	).pipe(
		Layer.provideMerge(Layer.merge(Workflows.layer, EngineHost.layerRpc)),
		Layer.provideMerge(ExecutionObservation.layer),
		Layer.provideMerge(Layer.merge(ExecutionStore.layer, ErrorRecords.layer)),
		// The engine generation reads the same config.
		Layer.provideMerge(config),
		Layer.provideMerge(Layer.succeed(PrivateRpc.Secret, options.clusterSecret)),
	)
}

/** Spending: the bills, the rate limits and the token limits. */
const layerSpending = Layer.mergeAll(
	BillingPostgres.layer,
	RateLimit.layer,
	TokenThrottle.layer,
)

/** The values of the options that plugins read when they start. */
const layerSettings = (options: Options) =>
	Layer.mergeAll(
		Layer.succeed(InstanceSettings, {
			databaseUrl: options.databaseUrl,
			development: options.development === true,
		}),
		Layer.succeed(AppWiring.IndexSources, options.indexSources),
		Layer.succeed(AppWiring.IndexWorkOptions, options.indexWork ?? {}),
		Layer.succeed(IndexNamespace, options.indexNamespace ?? "public"),
		Layer.succeed(ModelWiring.BuiltinModels, options.builtinModels),
		options.mailTransport ?? MailSmtp.layer,
	)

/**
 * The loader finds the plugins of the entries here. Graft's ambient context
 * holds it, but the host does not give it to callers.
 */
const resolver = (options: Options) =>
	ModuleResolver.fromRecord({ ...options.plugins, ...PresetPlugins.plugins })

/**
 * The services that the host builds for every plugin. A plugin reads them
 * from graft's ambient context, so no plugin can publish them.
 *
 * It needs the shared services (`Shared.layer`), the services from outside
 * of OpenBot (`Outside.Services`), the tools of the host, the platform
 * services, and the HTTP server with the router of `HttpRouter.serve`.
 */
export const layerKernel = (options: Options) =>
	Layer.mergeAll(
		HttpHost.layer,
		HttpFailureBoundary.layer,
		ErrorReporting.layerHttp,
	).pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				Calls.layer,
				Runner.layer,
				RunScope.layer,
				ConnectionScopes.layer,
				BotFeatures.layer,
			),
		),
		Layer.provideMerge(layerSpending),
		Layer.provideMerge(executionServices(options)),
		Layer.provideMerge(layerSettings(options)),
		Layer.provideMerge(PluginLogs.layer),
	)

/** The errors that stop the start of the host. */
export type StartError =
	| PresetPlugins.RequiredPluginMissing
	| Composition.PluginsInactive
	| Capture.CaptureMissing

/**
 * Starts the host in the current scope:
 *
 * 1. checks that the entries hold every required plugin;
 * 2. mounts the routes that the host owns;
 * 3. saves the failures of plugins from now on;
 * 4. loads the routes of executions and the loader;
 * 5. waits until every fork below them is active;
 * 6. opens the first engine generation.
 *
 * The scope closes these in the reverse order.
 */
export const start = (options: Options) =>
	Effect.gen(function* () {
		const entries = options.entries ?? PresetPlugins.entries
		yield* PresetPlugins.check(entries)
		const host = yield* HttpHost.HttpHost
		yield* Effect.all(
			[
				host.mount(["health"], Http.layerHealth),
				host.mountRoutes("execution-rpc", EngineHost.layerRoutes),
				host.mountRoutes("resource-rpc", ResourceTransport.layerRoutes),
			],
			{ discard: true },
		).pipe(
			// Each name has one mount, so a conflict is a broken rule of the code.
			Effect.catchTag("MountConflict", Effect.die),
		)
		const failures = yield* PluginFailures.make
		yield* failures.watch
		const executions = yield* Graft.plugin(HostPlugins.executions)
		const loaderFork = yield* Graft.plugin(
			HostPlugins.loader(yield* PresetPlugins.store(entries)),
		)
		const loader = Context.get(
			yield* Capture.context("openbot/loader-capture", [Loader.Loader]),
			Loader.Loader,
		)
		yield* loader.ready
		yield* Composition.settle({
			roots: [executions.id, loaderFork.id],
			errors: failures.flush,
		})
		yield* failures.flush
		// Private RPC uses its own client. The App network keeps its public-address guard.
		const undici = yield* Layer.build(NodeHttpClient.layerUndici)
		const graft = yield* Graft.Graft
		const stable = Composition.stable.pipe(
			Effect.provideService(Graft.Graft, graft),
		)
		yield* EngineHost.run({
			stable: Composition.stableOrWarn.pipe(
				Effect.provideService(Graft.Graft, graft),
			),
		}).pipe(
			Effect.provideService(
				HttpClient.HttpClient,
				Context.get(undici, HttpClient.HttpClient),
			),
		)
		return Composition.Composition.of({
			loader,
			forks: Graft.forks.pipe(Stream.provideService(Graft.Graft, graft)),
			stable,
		})
	})

/**
 * The bare host as a layer. It gives `Composition` and every service of the
 * kernel, but no service of a plugin, so it works with any entries. Its start
 * errors stay typed. Graft stays inside. It needs what `layerKernel` needs.
 */
export const layer = (options: Options) =>
	Layer.effect(Composition.Composition, start(options)).pipe(
		Layer.provide(Graft.layer),
		Layer.provide(resolver(options)),
		Layer.provideMerge(layerKernel(options)),
	)

/**
 * The host, and a snapshot of every service that the plugins publish, as they
 * are when the host has started. The capture fork holds them until the layer
 * closes, so it closes before the plugins. Graft stays inside. It works only
 * with every plugin of the preset.
 */
const exposed = (options: Options) =>
	Layer.effectContext(
		Effect.gen(function* () {
			const composition = yield* start(options)
			const published = yield* Capture.context(
				"openbot/expose",
				PresetPlugins.published,
			)
			return Context.add(published, Composition.Composition, composition)
		}),
	).pipe(
		Layer.provide(Graft.layer),
		Layer.provide(resolver(options)),
		Layer.provideMerge(layerKernel(options)),
	)

/**
 * The services that every plugin reads from graft's ambient context: those
 * the kernel builds, and those it needs from its caller (the shared and outside
 * services, the platform, and the HTTP server). A test checks that no plugin
 * publishes one.
 */
export type Kernel =
	| Layer.Success<ReturnType<typeof layerKernel>>
	| Layer.Services<ReturnType<typeof layerKernel>>

/** What startup work may use. */
export type StartupServices =
	| IndexWorkService
	| PgClient.PgClient
	| SecureRandom.SecureRandom
	| ErrorRecords.Records

/**
 * What more routes may use: the router, the platform, the database, the
 * settings, the sign-in check (`Auth`), the credit operations (`Wallets`),
 * and the services that the authentication and authorization middleware of
 * the contract need.
 */
export type RouteServices =
	| HttpRouter.HttpRouter
	| NodeServices.NodeServices
	| Etag.Generator
	| HttpPlatform.HttpPlatform
	| PgClient.PgClient
	| Settings
	| Wallets
	| Auth
	| RateLimit.RateLimiter
	| Organization
	| Tokens
	| Roles
	| PlatformAdmins

/** The options of the app. A changed list of entries needs the bare host. */
export interface AppOptions extends Omit<Options, "entries" | "plugins"> {
	/** Work that runs when the server starts, such as indexing the development App. */
	readonly startup?: Layer.Layer<never, never, StartupServices>
	/**
	 * More routes, such as the routes of the development tools. They come
	 * last, so they cannot take a route of OpenBot.
	 */
	readonly routes?: Layer.Layer<never, never, RouteServices>
}

const layerRoutes = (options: AppOptions) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const host = yield* HttpHost.HttpHost
			if (options.routes !== undefined)
				yield* host.mountRoutes("routes", options.routes, { last: true })
		}).pipe(
			// Each name has one mount, so a conflict is a broken rule of the code.
			Effect.catchTag("MountConflict", Effect.die),
		),
	)

/**
 * The routes and services of OpenBot on the plugin host, with the routes and
 * startup work of the options. It gives a snapshot of every service that the
 * plugins publish. A failed start is a defect, so the process stops. It needs
 * what `layerKernel` needs.
 */
export const layerApp = (options: AppOptions) =>
	Layer.mergeAll(layerRoutes(options), options.startup ?? Layer.empty).pipe(
		Layer.provideMerge(exposed(options)),
		Layer.orDie,
	)

/** The options of a server with its own Node.js HTTP server. */
export interface ServerOptions
	extends
		Omit<AppOptions, "development">,
		Serving.Listen,
		Partial<Serving.Fixed> {}

/**
 * Serves `layerApp` with its own Node.js HTTP server. Every route except
 * `/health` answers with SetupRequired while the platform has no settings.
 *
 * Without `auth`, sign-in follows the platform settings, and the server warns
 * when they are not there. With `auth`, the server first writes this one
 * sign-in configuration into the platform settings. Its development mode uses
 * the local test account.
 *
 * It needs the shared services, the services from outside, the tools of the
 * host, and the platform services.
 */
export const layerServer = (options: ServerOptions) => {
	const auth = options.auth
	const before: Layer.Layer<
		never,
		Layer.Error<ReturnType<typeof Serving.fixed>>,
		| Layer.Services<ReturnType<typeof Serving.fixed>>
		| Layer.Services<typeof Serving.warnBeforeSetup>
	> = auth === undefined
		? Serving.warnBeforeSetup
		: Serving.fixed({ ...options, auth })
	return Serving.serve(
		layerApp({ ...options, development: auth?.mode === "development" }),
	).pipe(Layer.provide(before), Layer.provideMerge(Serving.nodeServer(options)))
}
