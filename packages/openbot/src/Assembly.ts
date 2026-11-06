/**
 * How the parts of OpenBot come together on the graft host. The kernel gives
 * the services that every plugin shares. The loader runs the plugins of the
 * preset on top of it. Startup waits until every plugin is active, then opens
 * the first engine generation.
 *
 * This module is private. `Host` gives the public entry points.
 */
import { Graft, type Plugin as GraftPlugin } from "@graftland/graft"
import { type Entry, Loader, ModuleResolver } from "@graftland/loader"
import { NodeHttpClient } from "@effect/platform-node"
import {
	Array as Arr,
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
import { HttpClient, HttpServer } from "effect/http"
import { NetAddress } from "effect/net"
import * as BotFeatures from "@openbot-build/conversation-contract/chats/BotFeatures"
import * as BillingPostgres from "@openbot-build/server-billing/BillingPostgres"
import * as RateLimit from "@openbot-build/server-billing/RateLimit"
import * as TokenThrottle from "@openbot-build/server-billing/TokenThrottle"
import * as Calls from "@openbot-build/server-execution/Calls"
import * as ExecutionCommands from "@openbot-build/server-execution/Commands"
import * as ExecutionEngine from "@openbot-build/server-execution/Engine"
import * as EngineHost from "@openbot-build/server-execution/EngineHost"
import * as ExecutionObservation from "@openbot-build/server-execution/Observation"
import * as Runner from "@openbot-build/server-execution/Runner"
import * as RunScope from "@openbot-build/server-execution/RunScope"
import * as Send from "@openbot-build/server-execution/Send"
import * as ExecutionStore from "@openbot-build/server-execution/Store"
import * as Workflows from "@openbot-build/server-execution/Workflows"
import * as ConnectionScopes from "@openbot-build/server-execution/ConnectionScopes"
import * as ResourceDirectory from "@openbot-build/server-execution/Directory"
import * as ResourceTransport from "@openbot-build/server-execution/Transport"
import * as PrivateRpc from "@openbot-build/server-execution/PrivateRpc"
import { InstanceSettings } from "@openbot-build/server-kernel/InstanceSettings"
import * as HttpFailureBoundary from "@openbot-build/server-kernel/HttpBoundary"
import * as HttpHost from "@openbot-build/server-kernel/HttpHost"
import * as ErrorRecords from "@openbot-build/server-kernel/Records"
import * as ErrorReporting from "@openbot-build/server-kernel/Reporting"
import * as Capture from "./Capture.ts"
import * as Composition from "./Composition.ts"
import * as HostPlugins from "./HostPlugins.ts"
import * as Launch from "./Launch.ts"
import * as Http from "./Http.ts"
import * as Manifest from "./Manifest.ts"
import * as PluginFailures from "./PluginFailures.ts"
import * as PluginLogs from "./PluginLogs.ts"
import * as PluginsFile from "./PluginsFile.ts"
import * as PresetPlugins from "./PresetPlugins.ts"
import * as Wallets from "./Wallets.ts"

/** The settings of the host. They are plain values. */
export interface Options {
	readonly databaseUrl: Redacted.Redacted<string>
	/** The same private RPC secret on every node. */
	readonly clusterSecret: Redacted.Redacted<string>
	/** The address that other nodes can reach. Defaults to the bound server address. */
	readonly clusterHost?: string | undefined
	/**
	 * Use the local test account instead of a sign-in provider, and keep the
	 * App Index apart from the public one. The public origin and the sign-in
	 * secret still come from the platform settings.
	 */
	readonly development: boolean
	/** The entries of the loader. The default is `Preset.entries`. */
	readonly entries?: ReadonlyArray<Entry.Entry> | undefined
	/**
	 * More plugins that the entries can name, such as the plugins of a test.
	 * The plugins of the preset win over them.
	 */
	readonly plugins?: Readonly<Record<string, GraftPlugin.Plugin>> | undefined
	/**
	 * The path of the plugins file (`OPENBOT_PLUGINS_FILE`). The host reads it
	 * one time, when it starts, and changes the entries with it. It never
	 * writes the file.
	 */
	readonly pluginsFile?: string | undefined
	/**
	 * The forks of the caller, such as more routes or startup work. Each one
	 * waits for the services that it injects. The host runs them next to the
	 * loader, not as entries.
	 */
	readonly work?: ReadonlyArray<GraftPlugin.Plugin> | undefined
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
	Layer.succeed(InstanceSettings, {
		databaseUrl: options.databaseUrl,
		development: options.development,
		pluginsFile: Option.fromUndefinedOr(options.pluginsFile),
	})

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
 * of OpenBot (`Host.Outside`), the tools of the host, the platform
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
 * 4. loads the routes of executions, the credit operations, the loader, and
 *    the forks of the caller;
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
			...PresetPlugins.known,
			base: options.entries ?? PresetPlugins.known.base,
			bundled: Rec.keys(modules(options)),
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
		const wallets = yield* Graft.plugin(Wallets.plugin)
		const loaderFork = yield* Graft.plugin(
			HostPlugins.loader(yield* PresetPlugins.store(entries, known)),
		)
		const loader = Context.get(
			yield* Capture.context("openbot.loader-capture", [Loader.Loader]).pipe(
				// The entries passed the checks of the plugins file, so the loader
				// always publishes `Loader`. A missing key is a broken rule of the code.
				Effect.orDie,
			),
			Loader.Loader,
		)
		const work = yield* Effect.forEach(options.work ?? [], (plugin) =>
			Graft.plugin(plugin),
		)
		yield* loader.ready
		yield* Composition.settle({
			roots: [
				executions.id,
				wallets.id,
				loaderFork.id,
				...Arr.map(work, (fork) => fork.id),
			],
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
 * The host as a layer. It gives `Composition` and every service of the
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
 * The same host as `layer`, without `Composition`: the public entry points
 * give only the services of the kernel. A failed start is a
 * `Launch.StartFailed` with the error of the host as its cause.
 */
export const layerApp = (options: Options) =>
	Layer.effectDiscard(
		start(options).pipe(
			Effect.mapError((cause) =>
				Launch.StartFailed.make({
					reason: cause._tag,
					message: cause.message,
					cause,
				}),
			),
		),
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
