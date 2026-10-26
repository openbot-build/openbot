import * as DeveloperLayers from "../apps/DeveloperLayers.ts"
import * as AppExperience from "../apps/Experience.ts"
import * as Views from "../apps/Views.ts"
import * as AppIndex from "../apps/Index.ts"
import * as Connections from "../apps/Connections.ts"
import * as Lifecycle from "../apps/Lifecycle.ts"
import * as ConnectionLocks from "../apps/ConnectionLocks.ts"
import * as Capabilities from "../apps/Capabilities.ts"
import * as AppDiscovery from "../apps/Discovery.ts"
import * as AppPlugin from "../plugins/apps/AppPlugin.ts"
import * as Invocations from "../apps/Invocations.ts"
import * as Operations from "../apps/Operations.ts"
import * as ActionPolicy from "../apps/ActionPolicy.ts"
import * as Secrets from "../secrets/Secrets.ts"
import * as SettingsPostgres from "../settings/SettingsPostgres.ts"
import * as AppProbe from "../apps/Probe.ts"
import * as AppHost from "../apps/AppHost.ts"
import * as Authorizations from "../apps/Authorizations.ts"
import * as ProtocolStores from "../apps/ProtocolStores.ts"
import {
	CatalogDiscovery,
	AppConnections,
	type Discovery,
	PublicIndexing,
	RobotsPolicy,
	type Network,
} from "@openbot-build/protocol"
import * as OutboundPolicy from "../network/OutboundPolicy.ts"
import * as IndexWork from "../apps/IndexWork.ts"
import * as Governance from "../apps/Governance.ts"
import * as IndexStore from "../apps/IndexStore.ts"
import { IndexNamespace } from "../apps/IndexNamespace.ts"
import * as BackendLayers from "./BackendLayers.ts"
import * as BotLayers from "../bots/BotLayers.ts"
import * as Coordinator from "../bots/Coordinator.ts"
import * as CodeRuns from "../code/CodeRuns.ts"
import * as Sandbox from "../code/Sandbox.ts"
import * as Triggers from "../triggers/Triggers.ts"
import * as TriggerWorker from "../triggers/Worker.ts"
import * as Channels from "../channels/Channels.ts"
import * as ChannelQueue from "../channels/ChannelQueue.ts"
import * as ChannelRegistry from "../channels/ChannelRegistry.ts"
import * as ChannelWorker from "../channels/ChannelWorker.ts"
import * as ChannelPlugin from "../plugins/channels/ChannelPlugin.ts"
import * as ComputerProviders from "../computers/ComputerProviders.ts"
import * as Computers from "../computers/Computers.ts"
import * as Connectors from "../computers/connector/Connectors.ts"
import * as ComputerSessions from "../computers/Sessions.ts"
import * as StoredOperations from "../operations/StoredOperations.ts"
import * as Drivers from "../computers/Drivers.ts"
import * as Pairings from "../computers/Pairings.ts"
import * as ComputerWorker from "../computers/Worker.ts"
import * as Files from "../files/Files.ts"
import * as FileWorker from "../files/Worker.ts"
import * as ComputerPlugin from "../plugins/computers/ComputerPlugin.ts"
import * as VaultReaders from "../vaults/Readers.ts"
import * as SecretProviders from "../vaults/SecretProviders.ts"
import * as Vaults from "../vaults/Vaults.ts"
import * as Judge from "../capabilities/Judge.ts"
import * as HostTools from "../chats/HostTools.ts"
import * as ChatFeatures from "../chats/ChatFeatures.ts"
import type { Config } from "@openbot-build/core"
import { NodeSocket } from "@effect/platform-node"
import { Effect, Layer, type Redacted } from "effect"
import type { HttpClient } from "effect/http"
import * as DatabasePostgres from "../database/DatabasePostgres.ts"
import * as BetterAuth from "../auth/BetterAuth.ts"
import * as TokensPostgres from "../auth/TokensPostgres.ts"
import * as AuditLogPostgres from "../audit/AuditLogPostgres.ts"
import * as OrganizationPostgres from "../organization/OrganizationPostgres.ts"
import * as PlatformAdminsPostgres from "../platform/PlatformAdminsPostgres.ts"
import * as AuthorizationLayer from "../authorization/Layer.ts"
import * as RolesPostgres from "../authorization/RolesPostgres.ts"
import * as ModelRegistry from "../models/ModelRegistry.ts"
import * as LiveBackends from "../models/LiveBackends.ts"
import * as LiveSessions from "../chats/live/LiveSessions.ts"
import * as OpenAiRealtime from "../providers/openai/OpenAiRealtime.ts"
import * as BillingPostgres from "../billing/BillingPostgres.ts"
import * as RateLimit from "../billing/RateLimit.ts"
import * as TokenThrottle from "../billing/TokenThrottle.ts"
import * as ModelProvidersPostgres from "../models/ModelProvidersPostgres.ts"
import * as ModelsPostgres from "../models/ModelsPostgres.ts"
import * as SsoPostgres from "../sso/SsoPostgres.ts"
import * as DomainControl from "../apps/DomainControl.ts"

/** The settings of OpenBot. They are plain values. */
export interface Options {
	readonly databaseUrl: Redacted.Redacted<string>
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
	/**
	 * The model of a new Chat when its Bot names none. It is one of
	 * `builtinModels`. Only a simulated platform sets it, such as development
	 * or a test. On a real platform, each Bot names its model.
	 */
	readonly defaultModel?: Config.Selection
	readonly triggers?: TriggerWorker.Options
	readonly channels?: ChannelWorker.Options
	readonly computers?: ComputerWorker.Options
	readonly files?: FileWorker.Options
}

/**
 * The services from outside of OpenBot that `layer` needs: the drivers of the
 * Computer providers, the Live backends, the readers of the password
 * managers, the network and the check of Apps, the DNS check of domains, the
 * public network of the App Index, and the discovery of Apps. `layerOutside`
 * gives the real ones. A test gives fakes.
 */
export type Outside =
	| Drivers.Drivers
	| LiveBackends.LiveBackends
	| VaultReaders.Readers
	| AppProbe.Probe
	| AppHost.AppNetwork
	| DomainControl.DomainControl
	| Network.PublicNetwork
	| Discovery.Discovery

/** The Live backends of a real server. The `ws` package can send the key in a header. */
export const layerLiveBackends = Layer.unwrap(
	Effect.map(OpenAiRealtime.backend, (openai) => LiveBackends.layer([openai])),
).pipe(Layer.provide(NodeSocket.layerWebSocketConstructorWS))

/**
 * The real services from outside of OpenBot. They use the network of the
 * process, with the address rule of the outbound guard.
 */
export const layerOutside: Layer.Layer<Outside, never, HttpClient.HttpClient> =
	Layer.mergeAll(
		Drivers.layer,
		layerLiveBackends,
		VaultReaders.layer,
		AppProbe.layer,
		AppHost.layerNetwork,
		DomainControl.layer,
		OutboundPolicy.layerPublicNetwork,
		AppDiscovery.layerPublic,
	)

/**
 * The services that every part of OpenBot shares: the database pool, the
 * secret keys and the shared settings.
 */
export const layerShared = (options: {
	readonly databaseUrl: Redacted.Redacted<string>
	readonly secretKeys: Redacted.Redacted<string>
}) =>
	SettingsPostgres.layer.pipe(
		Layer.provideMerge(Secrets.layer(options.secretKeys)),
		Layer.provideMerge(
			Layer.effectDiscard(DatabasePostgres.check).pipe(
				Layer.provideMerge(DatabasePostgres.layer(options)),
			),
		),
	)

/** Each helper model comes from its own setting of the organization. */
const layerHelperModel = Layer.effect(
	Judge.HelperModel,
	Effect.map(ModelRegistry.ModelRegistry, (registry) => {
		const unavailable = (error: Config.ModelConfigurationError) =>
			Judge.HelperModelUnavailable.make({
				message: error.message,
				cause: error,
			})
		return Judge.HelperModel.of({
			rules: (organizationId) =>
				Effect.mapError(registry.rulesModel(organizationId), unavailable),
			botMemory: (organizationId) =>
				Effect.mapError(registry.botMemoryModel(organizationId), unavailable),
		})
	}),
)

/**
 * The Chat runtime of each member, with every plugin of a Turn. The runtimes
 * share one listener for the notices of their background Operations.
 */
const layerChats = (options: Options) =>
	BackendLayers.layer(
		options.defaultModel === undefined
			? {}
			: { defaultModel: options.defaultModel },
	).pipe(
		Layer.provide(
			Layer.merge(ChatFeatures.layer, StoredOperations.layerChannel),
		),
	)

/**
 * Apps: their connections, calls, authorizations and Operations, the Code
 * Mode runs, and the App plugin of each Turn.
 */
const layerApps = Layer.mergeAll(
	Lifecycle.layer,
	Authorizations.layer,
	AppPlugin.layer,
	Operations.layer,
).pipe(
	Layer.provideMerge(CodeRuns.layer),
	Layer.provide(Sandbox.layer),
	Layer.provideMerge(Invocations.layer),
	Layer.provideMerge(Connections.layer),
	Layer.provideMerge(Capabilities.layer),
	Layer.provideMerge(AppHost.layer),
	Layer.provide(CatalogDiscovery.layerRules),
	Layer.provide(AppConnections.layerConnectionScopes),
	Layer.provideMerge(ConnectionLocks.layer),
	Layer.provide(Layer.merge(ProtocolStores.layer, ActionPolicy.layer)),
)

/**
 * Channels and the Channel plugin of each Turn. A custom Channel calls an
 * address that an administrator chose, so it uses the network of Apps.
 */
const layerChannels = ChannelPlugin.layer.pipe(
	Layer.provideMerge(ChannelRegistry.layer),
	Layer.provideMerge(ChannelQueue.layer),
	Layer.provideMerge(Channels.layer),
)

/** Computers, their providers, pairings and command sessions, and the Computer plugin of each Turn. */
const layerComputers = ComputerPlugin.layer.pipe(
	Layer.provideMerge(ComputerSessions.layer),
	Layer.provideMerge(Pairings.layer),
	Layer.provideMerge(Computers.layer),
	Layer.provideMerge(Connectors.layer),
	Layer.provideMerge(ComputerProviders.layer),
)

/** Vaults and the secret providers that they read. */
const layerVaults = Vaults.layer.pipe(Layer.provideMerge(SecretProviders.layer))

/** The Bot services. The helper models come from the model registry. */
const layerBots = BotLayers.layer.pipe(Layer.provide(layerHelperModel))

/** The App Index, the work that reads App Catalogs into it, and its store. */
const layerIndex = (options: Options) => {
	const indexing = PublicIndexing.layerInspection.pipe(
		Layer.provide(CatalogDiscovery.layerRules),
		Layer.provide(RobotsPolicy.layer),
	)
	const work = IndexWork.layerWorker(options.indexWork).pipe(
		Layer.provideMerge(
			IndexWork.layer(options.indexWork).pipe(Layer.provide(indexing)),
		),
	)
	return Layer.merge(
		AppIndex.layer({
			simulated: options.indexNamespace === "development",
			...(options.indexSources === undefined
				? {}
				: { providers: options.indexSources }),
		}),
		work,
	).pipe(Layer.provideMerge(IndexStore.layer))
}

/**
 * Members, organizations, tokens, roles, platform admins, single sign-on, the
 * audit log, and the checks of permissions.
 */
const layerAccounts = AuthorizationLayer.layer.pipe(
	Layer.provideMerge(
		Layer.mergeAll(
			TokensPostgres.layer,
			OrganizationPostgres.layer,
			PlatformAdminsPostgres.layer,
			RolesPostgres.layer,
			SsoPostgres.layer,
		),
	),
	Layer.provideMerge(AuditLogPostgres.layer),
)

/**
 * The models: the stored providers and models, the model registry, and the
 * Live sessions of this process. The registry meters each model call, so the
 * spending services come before it.
 */
const layerModels = (options: Options) =>
	Layer.merge(
		ModelRegistry.layer(
			options.builtinModels === undefined
				? {}
				: { builtin: options.builtinModels },
		),
		LiveSessions.layer,
	).pipe(
		Layer.provideMerge(
			Layer.merge(ModelProvidersPostgres.layer, ModelsPostgres.layer),
		),
	)

/** Spending: the bills, the rate limits and the token limits. */
const layerSpending = Layer.mergeAll(
	BillingPostgres.layer,
	RateLimit.layer,
	TokenThrottle.layer,
)

/**
 * The services of OpenBot, with a separate stored runtime for each member. It
 * is built once for the life of the process. Values from the platform
 * settings, such as the public origin, are read each time they are used, so a
 * change to them needs no new build.
 *
 * It needs the shared services (`layerShared`), the services from outside of
 * OpenBot (`Outside`), the tools of the host (`HostTools`), and the platform
 * services, such as `NodeServices.layer` and `FetchHttpClient.layer`. The
 * services of a layer below are open to each layer above it.
 */
export const layer = (options: Options) =>
	Layer.mergeAll(
		Views.layer,
		AppExperience.layer,
		DeveloperLayers.layer,
		Coordinator.layer,
		TriggerWorker.layer(options.triggers),
		ComputerWorker.layer(options.computers),
		FileWorker.layer(options.files),
		ChannelWorker.layer(options.channels),
	).pipe(
		Layer.provideMerge(
			Layer.merge(
				layerChats(options),
				BetterAuth.layer({
					databaseUrl: options.databaseUrl,
					development: options.development === true,
				}),
			),
		),
		Layer.provideMerge(layerApps),
		Layer.provideMerge(Triggers.layer),
		Layer.provideMerge(
			Layer.mergeAll(layerChannels, layerComputers, layerVaults),
		),
		Layer.provideMerge(layerBots),
		Layer.provideMerge(layerIndex(options)),
		Layer.provideMerge(Governance.layer),
		Layer.provideMerge(layerAccounts),
		Layer.provideMerge(layerModels(options)),
		Layer.provideMerge(
			Layer.mergeAll(
				layerSpending,
				Files.layer,
				Layer.succeed(IndexNamespace, options.indexNamespace ?? "public"),
			),
		),
	)

/**
 * OpenBot with the real services from outside, and no tools of the host. It
 * still needs the shared services and the platform services.
 */
export const layerLive = (options: Options) =>
	layer(options).pipe(Layer.provide(Layer.merge(layerOutside, HostTools.none)))
