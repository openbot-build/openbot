/**
 * Test servers: a new database with its settings, the public plugin host with
 * fakes for the services from outside, control of its plugins and the
 * services of its plugins for a test, and a server that a test can restart.
 *
 * The control and the services of plugins come from probes: small plugins
 * that a test adds to the entries of the host. A probe waits for the keys
 * that it injects, like any plugin. Its value lives as long as its fork:
 * when a plugin that it injects restarts, graft closes the probe and starts
 * it again, and the probe gives the new services.
 */
import * as TestDatabase from "@openbot-build/server-database/Testing"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer.layer needs a function that makes a Node HTTP server.
import { createServer } from "node:http"
import { NodeCrypto, NodeHttpServer } from "@effect/platform-node"
import { type Fork, Graft, Plugin as GraftPlugin } from "@graftland/graft"
import { type Entry, Loader } from "@graftland/loader"
import { Host, Preset } from "@openbot-build/openbot"
import type { Discovery, Network } from "@openbot-build/protocol"
import {
	Array as Arr,
	Context,
	Deferred,
	Duration,
	Effect,
	Exit,
	Layer,
	Redacted,
	Option,
	Ref,
	Schema,
	Scope,
	Stream,
	String as Str,
	SynchronizedRef,
} from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import type { AppNetwork } from "@openbot-build/apps-contract/apps/AppNetwork"
import type { Transport as MailTransport } from "@openbot-build/identity-contract/mail/Transport"
import {
	type Builtin,
	BuiltinModels,
} from "@openbot-build/models-contract/BuiltinModels"
import type { LiveBackends } from "@openbot-build/models-contract/LiveBackends"
import type * as AppProbe from "@openbot-build/apps-contract/apps/Probe"
import type * as Drivers from "@openbot-build/apps-contract/computers/Drivers"
import type * as VaultReaders from "@openbot-build/apps-contract/vaults/Readers"
import type { DomainControl } from "@openbot-build/server-kernel/DomainControl"
import type * as HostTools from "@openbot-build/tools-contract/HostTools"

/** Fakes for the services from outside. Each one that is not here is the real one. */
export interface Outside {
	readonly computerDrivers?: Layer.Layer<Drivers.Drivers> | undefined
	readonly liveBackends?: Layer.Layer<LiveBackends> | undefined
	readonly vaultReaders?: Layer.Layer<VaultReaders.Readers> | undefined
	readonly appProbe?: Layer.Layer<AppProbe.Probe> | undefined
	readonly appNetwork?: Layer.Layer<AppNetwork> | undefined
	readonly domainControl?: Layer.Layer<DomainControl> | undefined
	readonly indexPublicNetwork?: Layer.Layer<Network.PublicNetwork> | undefined
	readonly discovery?: Layer.Layer<Discovery.Discovery> | undefined
	readonly mailTransport?: Layer.Layer<MailTransport> | undefined
	/** The models that the test gives itself. The default is none. */
	readonly builtinModels?: Builtin | undefined
}

/**
 * The fakes as one Layer for the `outside` option of `Host.layer`. The host
 * keeps the real service for each one that is not here.
 */
export const outside = (fakes: Outside): Layer.Layer<never> =>
	Arr.reduce(
		[
			fakes.computerDrivers,
			fakes.liveBackends,
			fakes.vaultReaders,
			fakes.appProbe,
			fakes.appNetwork,
			fakes.domainControl,
			fakes.indexPublicNetwork,
			fakes.discovery,
			fakes.mailTransport,
			fakes.builtinModels === undefined
				? undefined
				: Layer.succeed(BuiltinModels, fakes.builtinModels),
		],
		Layer.empty,
		(all: Layer.Layer<never>, fake: Layer.Layer<never> | undefined) =>
			fake === undefined ? all : Layer.merge(all, fake),
	)

/** A small plugin that a test adds to the entries of the host. */
export interface Probe<A> {
	/** The entry of the probe. Add it to the entries of the host. */
	readonly entry: Entry.Entry
	/** The plugin of the probe by module name. Add it to the plugins of the host. */
	readonly plugins: Readonly<Record<string, GraftPlugin.Plugin>>
	/**
	 * The value of the fork of the probe that runs now. It waits while the
	 * probe waits for its keys or starts again.
	 */
	readonly value: Effect.Effect<A>
}

/** The services that a list of keys gives. */
type Given<Keys extends ReadonlyArray<Context.Key<any, any>>> =
	Keys[number]["Identifier"]

/**
 * Makes a probe with this id. It waits for the keys in `inject`, and gives
 * what `read` makes from their services and from graft.
 */
const probe = <const Keys extends ReadonlyArray<Context.Key<any, any>>, A>(
	id: string,
	inject: Keys,
	read: (context: Context.Context<Given<Keys> | Graft.Graft>) => A,
) =>
	Effect.gen(function* () {
		const current = yield* Ref.make(yield* Deferred.make<A>())
		const name = `@openbot-build/server-testing/${id}`
		const plugin = GraftPlugin.make({
			name,
			inject,
			apply: () =>
				Effect.gen(function* () {
					const context = yield* Effect.context<Given<Keys> | Graft.Graft>()
					yield* Deferred.succeed(yield* Ref.get(current), read(context))
					// The next fork gives its own value.
					yield* Effect.addFinalizer(() =>
						Effect.flatMap(Deferred.make<A>(), (next) =>
							Ref.set(current, next),
						),
					)
				}),
		})
		const result: Probe<A> = {
			entry: { id, name },
			plugins: { [name]: plugin },
			value: Effect.flatMap(Ref.get(current), Deferred.await),
		}
		return result
	})

/**
 * A probe that gives the services of these keys, as the plugins that publish
 * them give them now. Use it to read the services of plugins in a test.
 */
export const services = <
	const Keys extends ReadonlyArray<Context.Key<any, any>>,
>(
	keys: Keys,
) => probe("test-services", keys, (context) => Context.pick(...keys)(context))

/** The control of the plugins of a running test host. */
export interface Control {
	/**
	 * Turns plugins on and off, changes their config and adds entries while
	 * the host runs. A required plugin cannot be turned off.
	 */
	readonly loader: Loader.Loader["Service"]
	/** The fork tree of the host, now and after each change. */
	readonly forks: Stream.Stream<ReadonlyArray<Fork.ForkTree>>
	/** Ends when no fork has been loading for a quarter of a second. */
	readonly stable: Effect.Effect<void>
}

/** Every fork of these trees, parents first. */
export const flatten = (
	trees: ReadonlyArray<Fork.ForkTree>,
): ReadonlyArray<Fork.ForkTree> =>
	Arr.flatMap(trees, (tree) => [tree, ...flatten(tree.children)])

/** A probe that gives the control of the plugins of the host. */
export const control = probe("test-control", [Loader.Loader], (context) => {
	const graft = Context.get(context, Graft.Graft)
	const forks = Graft.forks.pipe(Stream.provideService(Graft.Graft, graft))
	const result: Control = {
		loader: Context.get(context, Loader.Loader),
		forks,
		// A provider can become active while the consumer that it wakes still
		// waits, so the tree must stay still for a short time.
		stable: forks.pipe(
			Stream.map(flatten),
			Stream.debounce(Duration.millis(250)),
			Stream.filter(
				(all) => !Arr.some(all, (fork) => fork.state._tag === "Loading"),
			),
			Stream.runHead,
			Effect.asVoid,
		),
	}
	return result
})

/**
 * Starts a server with a probe of these keys in its entries, in the current
 * scope. `server` gets the entries and the plugins to give to the host. It
 * gives a function that runs an Effect with the services of the server and
 * the services of these keys, as the plugins give them now.
 */
export const startWith = <
	const Keys extends ReadonlyArray<Context.Key<any, any>>,
	A,
	E,
	R,
>(
	keys: Keys,
	server: (probe: {
		readonly entries: ReadonlyArray<Entry.Entry>
		readonly plugins: Readonly<Record<string, GraftPlugin.Plugin>>
	}) => Layer.Layer<A, E, R>,
) =>
	Effect.gen(function* () {
		const probe = yield* services(keys)
		const context = yield* Layer.build(
			server({
				entries: [...Preset.entries, probe.entry],
				plugins: probe.plugins,
			}),
		)
		return <B, E2>(effect: Effect.Effect<B, E2, A | Given<Keys>>) =>
			Effect.flatMap(probe.value, (plugins) =>
				Effect.provideContext(effect, Context.merge(context, plugins)),
			)
	})

/** The part of the cause of a `PluginsInactive` start failure that a test reads. */
const Inactive = Schema.Struct({
	forks: Schema.Array(
		Schema.Struct({
			plugin: Schema.String,
			state: Schema.String,
			errorId: Schema.optionalKey(Schema.String),
		}),
	),
})

/**
 * The forks that a failed start names as not active. The host gives them in
 * the cause of a `Launch.StartFailed` with the reason `PluginsInactive`.
 */
export const inactiveForks = (cause: unknown) =>
	Option.match(Schema.decodeUnknownOption(Inactive)(cause), {
		onNone: () => [],
		onSome: (inactive) => inactive.forks,
	})

/** The options of a test host. */
export interface Options {
	/**
	 * The database of the host. The default is a new one with the tables of
	 * OpenBot, which stops with the host. Give one from
	 * `TestDatabase.migrated` when two hosts share it, or when the test reads it.
	 */
	readonly database?: TestDatabase.Database | undefined
	/** The entries of the loader. The default is `Preset.entries`. */
	readonly entries?: ReadonlyArray<Entry.Entry> | undefined
	/** More plugins that the entries can name. */
	readonly plugins?: Readonly<Record<string, GraftPlugin.Plugin>> | undefined
	readonly pluginsFile?: string | undefined
	/** Fakes for the services from outside. */
	readonly outside?: Outside | undefined
	readonly hostTools?: Layer.Layer<HostTools.HostTools> | undefined
	readonly work?: ReadonlyArray<Host.Work> | undefined
	/** The probes of the test. The host adds their entries after the others. */
	readonly probes?: ReadonlyArray<Probe<unknown>> | undefined
}

/** The secrets of every test host. They stay the same, so a second host can read what the first one wrote. */
const secretKeys = Redacted.make("test:" + Str.repeat(32)("11"))
const clusterSecret = Redacted.make(
	"test-cluster-secret-with-at-least-32-characters",
)

/**
 * The public app (`Host.layerApp`) on its own Node.js HTTP server at
 * 127.0.0.1 and a free port, with the probes of the test. Like a host that a
 * program serves itself, it has no check of the platform settings, so the
 * routes answer before setup. Its start errors stay typed. It gives the
 * services of the kernel and no service of a plugin: a test reads those
 * through a probe. Give it `NodeServices.layer` and `FetchHttpClient.layer`.
 */
export const layer = (options: Options) => {
	const probes = options.probes ?? []
	const app = (database: TestDatabase.Database) =>
		Host.layerApp({
			...options,
			databaseUrl: Redacted.make(database.url),
			secretKeys,
			clusterSecret,
			entries: [
				...(options.entries ?? Preset.entries),
				...Arr.map(probes, (each) => each.entry),
			],
			plugins: Object.assign(
				{},
				options.plugins,
				...Arr.map(probes, (each) => each.plugins),
			),
			outside: outside(options.outside ?? {}),
		})
	return HttpRouter.serve(
		Layer.unwrap(
			Effect.map(
				options.database === undefined
					? TestDatabase.migrated
					: Effect.succeed(options.database),
				app,
			),
		),
		{ disableLogger: true, disableListenLog: true },
	).pipe(
		Layer.provideMerge(NodeCrypto.layer),
		Layer.provideMerge(
			NodeHttpServer.layer(() => createServer(), {
				host: "127.0.0.1",
				port: 0,
			}),
		),
	)
}

/** A server that runs in its own scope. A test can stop it and start it again. */
export interface Running<A, E> {
	/** The address of the server, such as http://127.0.0.1:4000. A restart changes it. */
	readonly address: Effect.Effect<string>
	/** Runs an Effect with the services of the server that runs now. */
	readonly run: <B, E2>(
		effect: Effect.Effect<B, E2, A | HttpServer.HttpServer>,
	) => Effect.Effect<B, E2>
	/** Stops the server and starts a new one with the same settings. */
	readonly restart: Effect.Effect<void, E>
}

/**
 * Starts a server in a new scope inside the current scope. Each start uses a
 * new memo map, so it builds every layer again, as in a new process.
 * `restart` stops the server and starts it again, with the same services that
 * the first start had.
 */
export const launch = <A, E, R>(
	server: Layer.Layer<A | HttpServer.HttpServer, E, R>,
) =>
	Effect.gen(function* () {
		const scope = yield* Effect.scope
		const context = yield* Effect.context<R>()
		const start = Effect.gen(function* () {
			const serverScope = yield* Scope.fork(scope)
			const services = yield* Layer.buildWithMemoMap(
				server,
				yield* Layer.makeMemoMap,
				serverScope,
			).pipe(Effect.provideContext(context))
			return {
				scope: serverScope,
				services,
				address: HttpServer.formatAddress(
					Context.get(services, HttpServer.HttpServer).address,
				),
			}
		})
		const current = yield* SynchronizedRef.make(yield* start)
		const running: Running<A, E> = {
			address: Effect.map(SynchronizedRef.get(current), (now) => now.address),
			run: (effect) =>
				Effect.flatMap(SynchronizedRef.get(current), (now) =>
					Effect.provideContext(effect, now.services),
				),
			restart: SynchronizedRef.updateEffect(current, (now) =>
				Scope.close(now.scope, Exit.void).pipe(Effect.andThen(start)),
			),
		}
		return running
	})
