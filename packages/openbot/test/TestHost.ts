/**
 * Test servers: a new database with its settings, the bare plugin host, fakes
 * for the services from outside, a server that a test can restart, and the API
 * without the plugin host.
 */
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import type { Discovery, Network } from "@openbot-build/protocol"
import {
	Context,
	Effect,
	Exit,
	Layer,
	Redacted,
	Scope,
	String as Str,
	SynchronizedRef,
} from "effect"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http"
import * as Assembly from "../src/app/Assembly.ts"
import * as DatabasePostgres from "../src/app/DatabasePostgres.ts"
import * as Http from "../src/app/Http.ts"
import * as Outside_ from "../src/app/Outside.ts"
import * as Serving from "../src/app/Serving.ts"
import * as Shared from "../src/app/Shared.ts"
import type { LiveBackends } from "@openbot-build/models-contract/models/LiveBackends"
import * as AccessMounts from "@openbot-build/plugin-access/HttpMounts"
import * as AppHost from "../src/plugin-apps/AppHost.ts"
import * as AppDiscovery from "../src/plugin-apps/Discovery.ts"
import * as AppsMounts from "../src/plugin-apps/HttpMounts.ts"
import * as Probe from "../src/plugin-apps/Probe.ts"
import { HttpHandlers as AuthHttpHandlers } from "@openbot-build/plugin-auth/Auth"
import * as AuthMounts from "@openbot-build/plugin-auth/HttpMounts"
import * as AuthorizationLayer from "@openbot-build/plugin-authorization/Layer"
import * as BillingMounts from "@openbot-build/plugin-billing/HttpMounts"
import * as BotsMounts from "../src/plugin-bots/HttpMounts.ts"
import * as CapabilitiesMounts from "../src/plugin-capabilities/HttpMounts.ts"
import * as ChannelsMounts from "../src/plugin-channels/HttpMounts.ts"
import * as ChatsMounts from "../src/plugin-chats/HttpMounts.ts"
import * as CodeMounts from "../src/plugin-code/HttpMounts.ts"
import * as Drivers from "../src/plugin-computers/Drivers.ts"
import * as ComputersMounts from "../src/plugin-computers/HttpMounts.ts"
import * as FilesMounts from "../src/plugin-files/HttpMounts.ts"
import * as ModelsMounts from "../src/plugin-models/HttpMounts.ts"
import * as OrganizationMounts from "@openbot-build/plugin-organization/HttpMounts"
import * as PlatformMounts from "@openbot-build/plugin-platform/HttpMounts"
import * as SettingsMounts from "@openbot-build/plugin-settings/HttpMounts"
import * as SsoMounts from "@openbot-build/plugin-sso/HttpMounts"
import * as TriggersMounts from "../src/plugin-triggers/HttpMounts.ts"
import * as VaultReaders from "../src/plugin-vaults/Readers.ts"
import * as VaultsMounts from "../src/plugin-vaults/HttpMounts.ts"
import * as ExecutionHandlers from "@openbot-build/server-execution/execution/HttpHandlers"
import * as DomainControl from "@openbot-build/server-kernel/apps/DomainControl"
import * as HttpFailureBoundary from "@openbot-build/server-kernel/errors/HttpBoundary"
import * as HttpHost from "@openbot-build/server-kernel/errors/HttpHost"
import * as ErrorReporting from "@openbot-build/server-kernel/errors/Reporting"
import * as OutboundPolicy from "@openbot-build/server-kernel/network/OutboundPolicy"
import * as HostTools from "@openbot-build/tools-contract/chats/HostTools"
import * as PostgresTest from "./PostgresTest.ts"

/** The services that a test server needs: the Node services, crypto and the fetch HTTP client. */
export const layerPlatform = Layer.mergeAll(
	NodeServices.layer,
	NodeCrypto.layer,
	FetchHttpClient.layer,
)

/** The settings of a test server: a database, fixed secrets, 127.0.0.1 and a free port. */
export interface Settings {
	readonly databaseUrl: Redacted.Redacted<string>
	readonly secretKeys: Redacted.Redacted<string>
	readonly clusterSecret: Redacted.Redacted<string>
	readonly host: string
	readonly port: number
}

/** Starts a new PostgreSQL that stops with the scope, and gives the settings of a server on it. */
export const makeSettings = Effect.map(
	PostgresTest.start,
	(database): Settings => ({
		databaseUrl: Redacted.make(database.url),
		secretKeys: Redacted.make("test:" + Str.repeat(32)("11")),
		clusterSecret: Redacted.make(
			"test-cluster-secret-with-at-least-32-characters",
		),
		host: "127.0.0.1",
		port: 0,
	}),
)

/** Makes the tables of a new database. The migration has its own pool, which closes after it. */
export const migrate = (settings: {
	readonly databaseUrl: Redacted.Redacted<string>
}) =>
	DatabasePostgres.migrate.pipe(
		Effect.provide(
			DatabasePostgres.layer(settings).pipe(
				Layer.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
			),
		),
	)

/**
 * The shared services of OpenBot alone: the database pool, the secret keys,
 * the shared settings and the error records.
 */
export const layerShared = Shared.layer

/** Fakes for the services from outside. Each one that is not here is the real one. */
export interface Outside {
	readonly computerDrivers?: Layer.Layer<Drivers.Drivers> | undefined
	readonly liveBackends?: Layer.Layer<LiveBackends> | undefined
	readonly vaultReaders?: Layer.Layer<VaultReaders.Readers> | undefined
	readonly appProbe?: Layer.Layer<Probe.Probe> | undefined
	readonly appNetwork?: Layer.Layer<AppHost.AppNetwork> | undefined
	readonly domainControl?: Layer.Layer<DomainControl.DomainControl> | undefined
	readonly indexPublicNetwork?: Layer.Layer<Network.PublicNetwork> | undefined
	readonly discovery?: Layer.Layer<Discovery.Discovery> | undefined
}

/** The services from outside: the fakes of the test, or the real ones. */
export const layerOutside = (fakes: Outside = {}) =>
	Layer.mergeAll(
		fakes.computerDrivers ?? Drivers.layer,
		fakes.liveBackends ?? Outside_.layerLiveBackends,
		fakes.vaultReaders ?? VaultReaders.layer,
		fakes.appProbe ?? Probe.layer,
		fakes.appNetwork ?? AppHost.layerNetwork,
		fakes.domainControl ?? DomainControl.layer,
		fakes.indexPublicNetwork ?? OutboundPolicy.layerPublicNetwork,
		fakes.discovery ?? AppDiscovery.layerPublic,
	)

/**
 * The bare plugin host on its own HTTP server, with the real services from
 * outside, no tools of the host, and the shared services. It takes a changed
 * list of entries, more plugins and a plugins file, and its start errors stay
 * typed. It gives
 * no service of a plugin. Give it `layerPlatform`.
 */
export const layer = (
	options: Settings &
		Pick<Assembly.Options, "entries" | "plugins" | "pluginsFile">,
) =>
	HttpRouter.serve(Assembly.layer(options), {
		disableLogger: true,
		disableListenLog: true,
	}).pipe(
		Layer.provide(Layer.merge(Outside_.layer, HostTools.none)),
		Layer.provideMerge(Shared.layer(options)),
		Layer.provideMerge(NodeCrypto.layer),
		Layer.provideMerge(Serving.nodeServer(options)),
	)

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

/**
 * Mounts every group of the contract for the life of the server. Each plugin
 * folder gives the mounts of its groups.
 */
const layerGroups = Layer.effectDiscard(
	Effect.gen(function* () {
		const host = yield* HttpHost.HttpHost
		yield* Effect.all(
			[
				host.mount(["health"], Http.layerHealth),
				host.mount(["executions"], ExecutionHandlers.layer),
				AuthMounts.mount,
				AccessMounts.mount,
				AppsMounts.mount,
				CodeMounts.mount,
				ChatsMounts.mount,
				BotsMounts.mount,
				CapabilitiesMounts.mount,
				SettingsMounts.mount,
				TriggersMounts.mount,
				FilesMounts.mount,
				ChannelsMounts.mount,
				ComputersMounts.mount,
				VaultsMounts.mount,
				BillingMounts.mount,
				OrganizationMounts.mount,
				ModelsMounts.mount,
				PlatformMounts.mount,
				SsoMounts.mount,
			],
			{ concurrency: "unbounded", discard: true },
		).pipe(
			// Each group has one mount in this list, so a conflict is a broken rule of the code.
			Effect.catchTag("MountConflict", Effect.die),
		)
	}),
)

/** Better Auth serves its own routes under `/auth`. A contract route always wins over them. */
const layerBetterAuth = Layer.effectDiscard(
	AuthMounts.mountBetterAuth.pipe(
		// No other mount has this name, so a conflict is a broken rule of the code.
		Effect.catchTag("MountConflict", Effect.die),
	),
)

/**
 * Every group of the contract for the life of the server, with the
 * authentication and authorization middleware, the failure boundary and the
 * error logs of failed requests. It has no plugin host: the test gives the
 * services of the groups, often as mocks. Serve it with `HttpRouter.serve`.
 */
export const layerApi = Layer.mergeAll(
	layerGroups,
	layerBetterAuth,
	ErrorReporting.layerHttp,
).pipe(
	// The authorization middleware stays open to the other groups, as before.
	Layer.provide(
		AuthHttpHandlers.layerMiddleware.pipe(
			Layer.provideMerge(AuthorizationLayer.layer),
		),
	),
	Layer.provide(HttpFailureBoundary.layer),
	Layer.provideMerge(HttpHost.layer),
)
