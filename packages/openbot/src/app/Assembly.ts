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
import {
	Context,
	Effect,
	Layer,
	Option,
	PrimaryKey,
	Record as Rec,
	type Redacted,
	Stream,
} from "effect"
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
import { IndexWork as IndexWorkService } from "../apps-contract/apps/IndexWork.ts"
import * as BotFeatures from "../conversation-contract/chats/BotFeatures.ts"
import { Auth } from "@openbot-build/identity-contract/auth/Auth"
import { Tokens } from "@openbot-build/identity-contract/auth/Tokens"
import { Roles } from "@openbot-build/identity-contract/authorization/Roles"
import type { Transport as MailTransport } from "@openbot-build/identity-contract/mail/Transport"
import { Organization } from "@openbot-build/identity-contract/organization/Organization"
import { PlatformAdmins } from "@openbot-build/identity-contract/platform/PlatformAdmins"
import type * as AppIndex from "../plugin-apps/Index.ts"
import type * as IndexWork from "../plugin-apps/IndexWork.ts"
import * as AppWiring from "../plugin-apps/Wiring.ts"
import * as MailSmtp from "../plugin-mail/Smtp.ts"
import type * as ModelRegistry from "../plugin-models/ModelRegistry.ts"
import * as ModelWiring from "../plugin-models/Wiring.ts"
import * as BillingPostgres from "@openbot-build/server-billing/billing/BillingPostgres"
import { Wallets } from "@openbot-build/server-billing/billing/Host"
import * as RateLimit from "@openbot-build/server-billing/billing/RateLimit"
import * as TokenThrottle from "@openbot-build/server-billing/billing/TokenThrottle"
import * as Calls from "@openbot-build/server-execution/execution/Calls"
import * as ExecutionCommands from "@openbot-build/server-execution/execution/Commands"
import * as ExecutionEngine from "@openbot-build/server-execution/execution/Engine"
import * as EngineHost from "@openbot-build/server-execution/execution/EngineHost"
import * as ExecutionObservation from "@openbot-build/server-execution/execution/Observation"
import * as Runner from "@openbot-build/server-execution/execution/Runner"
import * as RunScope from "@openbot-build/server-execution/execution/RunScope"
import * as Send from "@openbot-build/server-execution/execution/Send"
import * as ExecutionStore from "@openbot-build/server-execution/execution/Store"
import * as Workflows from "@openbot-build/server-execution/execution/Workflows"
import * as ConnectionScopes from "@openbot-build/server-execution/resources/ConnectionScopes"
import * as ResourceDirectory from "@openbot-build/server-execution/resources/Directory"
import * as ResourceTransport from "@openbot-build/server-execution/resources/Transport"
import * as PrivateRpc from "@openbot-build/server-execution/transport/PrivateRpc"
import { InstanceSettings } from "@openbot-build/server-kernel/configuration/InstanceSettings"
import * as HttpFailureBoundary from "@openbot-build/server-kernel/errors/HttpBoundary"
import * as HttpHost from "@openbot-build/server-kernel/errors/HttpHost"
import * as ErrorRecords from "@openbot-build/server-kernel/errors/Records"
import * as ErrorReporting from "@openbot-build/server-kernel/errors/Reporting"
import type { Settings } from "@openbot-build/server-kernel/settings/Settings"
import * as Capture from "./Capture.ts"
import * as Composition from "./Composition.ts"
import * as HostPlugins from "./HostPlugins.ts"
import * as Http from "./Http.ts"
import * as Manifest from "./Manifest.ts"
import * as PluginFailures from "./PluginFailures.ts"
import * as PluginLogs from "./PluginLogs.ts"
import * as PluginsFile from "./PluginsFile.ts"
import * as Preset from "./Preset.ts"
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
	/**
	 * The path of the plugins file (`OPENBOT_PLUGINS_FILE`). The host reads it
	 * one time, when it starts, and changes the entries with it. It never
	 * writes the file.
	 */
	readonly pluginsFile?: string | undefined
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
			pluginsFile: Option.fromUndefinedOr(options.pluginsFile),
		}),
		Layer.succeed(AppWiring.IndexSources, options.indexSources),
		Layer.succeed(AppWiring.IndexWorkOptions, options.indexWork ?? {}),
		Layer.succeed(IndexNamespace, options.indexNamespace ?? "public"),
		Layer.succeed(ModelWiring.BuiltinModels, options.builtinModels),
		options.mailTransport ?? MailSmtp.layer,
	)

/** Every plugin that an entry can name, by module name. No other plugin can run. */
const modules = (options: Options) => ({
	...options.plugins,
	...PresetPlugins.plugins,
})

/**
 * The loader finds the plugins of the entries here. Graft's ambient context
 * holds it, but the host does not give it to callers.
 */
const resolver = (options: Options) =>
	ModuleResolver.fromRecord(modules(options))

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
	| PluginsFile.PluginsFileInvalid
	| PluginsFile.PluginsFileUnreadable

/**
 * The entries of the loader: the entries of the options, or the preset,
 * changed by the plugins file when the settings name one.
 */
const loadEntries = (known: PluginsFile.Known) =>
	Effect.gen(function* () {
		const settings = yield* InstanceSettings
		if (Option.isNone(settings.pluginsFile)) return known.base
		const file = settings.pluginsFile.value
		const entries = yield* PluginsFile.load(file, known).pipe(
			Effect.tapError(PluginsFile.logFailure),
		)
		const changes = PluginsFile.changes(known, entries)
		// No config goes into the log: it can hold a value from the file.
		yield* Effect.logInfo("OpenBot read the plugins file.").pipe(
			Effect.annotateLogs({
				file,
				off: changes.off,
				added: changes.added,
				manifestHash: yield* PluginsFile.manifestHash(entries),
			}),
		)
		return entries
	})

/**
 * Starts the host in the current scope:
 *
 * 1. reads the plugins file, and checks that the entries hold every required
 *    plugin;
 * 2. mounts the routes that the host owns;
 * 3. saves the failures of plugins from now on;
 * 4. loads the routes of executions and the loader;
 * 5. waits until every fork below them is active;
 * 6. opens the first engine generation;
 * 7. writes the manifest of this runner now and on a timer, and warns when
 *    another live runner runs other plugins. This never stops the start.
 *
 * The scope closes these in the reverse order.
 */
export const start = (options: Options) =>
	Effect.gen(function* () {
		const known: PluginsFile.Known = {
			base: options.entries ?? PresetPlugins.entries,
			bundled: Rec.keys(modules(options)),
			required: Preset.required,
			configurable: PluginsFile.configurable,
		}
		const entries = yield* loadEntries(known)
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
			HostPlugins.loader(yield* PresetPlugins.store(entries, known)),
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
		// The heartbeat comes after the engine, so it stops first and deletes its row.
		const address = Option.match(
			(yield* ShardingConfig.ShardingConfig).runnerAddress,
			{
				onNone: () => Effect.die("The host has no runner address."),
				onSome: (runner) => Effect.succeed(PrimaryKey.value(runner)),
			},
		)
		yield* Manifest.heartbeat({
			address: yield* address,
			entries: loader.entries,
			roots: [executions.id, loaderFork.id],
		}).pipe(Effect.provideService(Graft.Graft, graft))
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
 * The host, and a snapshot of these services of the plugins, as they are when
 * the host has started. The capture fork holds them until the layer closes,
 * so it closes before the plugins. Graft stays inside. A key of a plugin that
 * is off is never published, so the start fails with `CaptureMissing`.
 */
const exposed = <const Keys extends ReadonlyArray<Context.Key<any, any>>>(
	options: Options,
	keys: Keys,
) =>
	Layer.effectContext(
		Effect.gen(function* () {
			const composition = yield* start(options)
			const published = yield* Capture.context("openbot/expose", keys)
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

const layerAppWith = <const Keys extends ReadonlyArray<Context.Key<any, any>>>(
	options: AppOptions,
	keys: Keys,
) =>
	Layer.mergeAll(layerRoutes(options), options.startup ?? Layer.empty).pipe(
		Layer.provideMerge(exposed(options, keys)),
		Layer.orDie,
	)

/**
 * The routes and services of OpenBot on the plugin host, with the routes and
 * startup work of the options. It gives a snapshot of every service that the
 * plugins publish, so every plugin must be on: with a plugin that the plugins
 * file turns off, the start fails with `CaptureMissing`. A failed start is a
 * defect, so the process stops. It needs what `layerKernel` needs.
 */
export const layerApp = (options: AppOptions) =>
	layerAppWith(options, PresetPlugins.published)

/** The services of plugins in `RouteServices`. */
const routeKeys = [
	Wallets,
	Auth,
	Organization,
	Tokens,
	Roles,
	PlatformAdmins,
] as const

/** The services of plugins in `StartupServices`. */
const startupKeys = [IndexWorkService] as const

/**
 * The services of plugins that the routes and the startup work of the options
 * use, and only when the options have routes or startup work. The type names
 * every key, but nothing reads a key of routes or startup work that is not
 * there.
 */
const neededKeys = (options: AppOptions) => [
	...(options.routes === undefined ? [] : routeKeys),
	...(options.startup === undefined ? [] : startupKeys),
]

/** The options of a server with its own Node.js HTTP server. */
export interface ServerOptions
	extends
		Omit<AppOptions, "development">,
		Serving.Listen,
		Partial<Serving.Fixed> {}

const serverWith = <const Keys extends ReadonlyArray<Context.Key<any, any>>>(
	options: ServerOptions,
	keys: (app: AppOptions) => Keys,
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
	const app = { ...options, development: auth?.mode === "development" }
	return Serving.serve(layerAppWith(app, keys(app))).pipe(
		Layer.provide(before),
		Layer.provideMerge(Serving.nodeServer(options)),
	)
}

/**
 * Serves `layerApp` with its own Node.js HTTP server. Every route except
 * `/health` answers with SetupRequired while the platform has no settings.
 *
 * Without `auth`, sign-in follows the platform settings, and the server warns
 * when they are not there. With `auth`, the server first writes this one
 * sign-in configuration into the platform settings. Its development mode uses
 * the local test account.
 *
 * It gives a snapshot of every service that the plugins publish, so every
 * plugin must be on, as for `layerApp`.
 *
 * It needs the shared services, the services from outside, the tools of the
 * host, and the platform services.
 */
export const layerServer = (options: ServerOptions) =>
	serverWith(options, () => PresetPlugins.published)

/**
 * The same server as `layerServer`, for a program that does not use the
 * services of the plugins, such as `openbot-server`. It gives no snapshot. It
 * waits only for the services that the routes and the startup work of the
 * options need, so a plugin that the plugins file turns off does not stop it.
 */
export const layerProgram = (options: ServerOptions) =>
	serverWith(options, neededKeys)
