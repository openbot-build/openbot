import * as Access from "../identity-contract/access/Access.ts"
import * as ConnectionScopes from "../server-execution/resources/ConnectionScopes.ts"
import * as ErrorRecords from "../server-kernel/errors/Records.ts"
import * as ConnectionCommands from "../plugin-apps/ConnectionCommands.ts"
import * as GrantCleanup from "../plugin-apps/GrantCleanup.ts"
import * as ResetCommands from "../plugin-apps/ResetCommands.ts"
import * as AuthorizationCommands from "../plugin-apps/AuthorizationCommands.ts"
import * as ChannelInbox from "../plugin-channels/ChannelInbox.ts"
import * as ChannelWatch from "../plugin-channels/ChannelWatch.ts"
import * as DeveloperLayers from "../plugin-apps/DeveloperLayers.ts"
import * as AppExperience from "../plugin-apps/Experience.ts"
import * as AppIndex from "../plugin-apps/Index.ts"
import * as Connections from "../plugin-apps/Connections.ts"
import * as Lifecycle from "../plugin-apps/Lifecycle.ts"
import * as ConnectionSessions from "../plugin-apps/ConnectionSessions.ts"
import * as AppDiscovery from "../plugin-apps/Discovery.ts"
import * as ActionPolicy from "../plugin-apps/ActionPolicy.ts"
import * as Secrets from "../server-kernel/secrets/Secrets.ts"
import * as SettingsPostgres from "../server-kernel/settings/SettingsPostgres.ts"
import * as AppProbe from "../plugin-apps/Probe.ts"
import * as AppHost from "../plugin-apps/AppHost.ts"
import * as Authorizations from "../plugin-apps/Authorizations.ts"
import * as ProtocolStores from "../plugin-apps/ProtocolStores.ts"
import {
	CatalogDiscovery,
	type Discovery,
	PublicIndexing,
	RobotsPolicy,
	type Network,
} from "@openbot-build/protocol"
import * as OutboundPolicy from "../server-kernel/network/OutboundPolicy.ts"
import * as IndexWork from "../plugin-apps/IndexWork.ts"
import * as Governance from "../plugin-apps/Governance.ts"
import * as IndexStore from "../plugin-apps/IndexStore.ts"
import { IndexNamespace } from "../apps-contract/apps/IndexNamespace.ts"
import * as BotLayers from "../plugin-bots/BotLayers.ts"
import * as Triggers from "../plugin-triggers/Triggers.ts"
import * as Channels from "../plugin-channels/Channels.ts"
import * as ChannelQueue from "../plugin-channels/ChannelQueue.ts"
import * as ChannelRegistry from "../plugin-channels/ChannelRegistry.ts"
import * as ComputerProviders from "../plugin-computers/ComputerProviders.ts"
import * as Computers from "../plugin-computers/Computers.ts"
import * as Connectors from "../plugin-computers/connector/Connectors.ts"
import * as ComputerSessions from "../plugin-computers/Sessions.ts"
import * as Drivers from "../plugin-computers/Drivers.ts"
import * as Pairings from "../plugin-computers/Pairings.ts"
import * as ComputerLifecycle from "../plugin-computers/Lifecycle.ts"
import * as Files from "../plugin-files/Files.ts"
import * as FileTasks from "../plugin-files/FileTasks.ts"
import * as VaultReaders from "../plugin-vaults/Readers.ts"
import * as SecretProviders from "../plugin-vaults/SecretProviders.ts"
import * as Vaults from "../plugin-vaults/Vaults.ts"
import * as HostTools from "../tools-contract/chats/HostTools.ts"
import { NodeWS } from "@effect/platform-node"
import { Effect, Layer, type Redacted } from "effect"
import type { HttpClient } from "effect/http"
import * as DatabasePostgres from "../server-kernel/database/DatabasePostgres.ts"
import * as BetterAuth from "../plugin-auth/BetterAuth.ts"
import * as TokensPostgres from "../plugin-auth/TokensPostgres.ts"
import * as AuditLogPostgres from "../plugin-audit/AuditLogPostgres.ts"
import * as OrganizationPostgres from "../plugin-organization/OrganizationPostgres.ts"
import * as PlatformAdminsPostgres from "../plugin-platform/PlatformAdminsPostgres.ts"
import * as AuthorizationLayer from "../plugin-authorization/Layer.ts"
import * as RolesPostgres from "../plugin-authorization/RolesPostgres.ts"
import * as ModelRegistry from "../models-contract/models/ModelRegistry.ts"
import * as ProviderOAuth from "../models-contract/models/ProviderOAuth.ts"
import * as ChatGptOAuth from "../model-providers/providers/chatgpt/OAuth.ts"
import * as LiveBackends from "../models-contract/models/LiveBackends.ts"
import * as OpenAiRealtime from "../model-providers/providers/openai/OpenAiRealtime.ts"
import * as BillingPostgres from "../server-billing/billing/BillingPostgres.ts"
import * as RateLimit from "../server-billing/billing/RateLimit.ts"
import * as TokenThrottle from "../server-billing/billing/TokenThrottle.ts"
import * as ModelProvidersPostgres from "../plugin-models/ModelProvidersPostgres.ts"
import * as ModelsPostgres from "../plugin-models/ModelsPostgres.ts"
import * as SsoPostgres from "../plugin-sso/SsoPostgres.ts"
import * as DomainControl from "../server-kernel/apps/DomainControl.ts"
import * as Mail from "../identity-contract/mail/Mail.ts"
import * as MailSmtp from "../plugin-mail/Smtp.ts"
import type { Transport as MailTransport } from "../identity-contract/mail/Transport.ts"

/** The settings of OpenBot. They are plain values. */
export interface Options {
	readonly databaseUrl: Redacted.Redacted<string>
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
).pipe(Layer.provide(NodeWS.layerWebSocketConstructor))

/**
 * The real services from outside of OpenBot. They use the network of the
 * process, with the address rule of the outbound guard.
 */
export const layerOutside: Layer.Layer<
	Outside,
	never,
	HttpClient.HttpClient | ErrorRecords.Records
> = Layer.mergeAll(
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
		Layer.provideMerge(ErrorRecords.layer),
		Layer.provideMerge(Secrets.layer(options.secretKeys)),
		Layer.provideMerge(
			// The data version and maintenance lock must pass before any service starts.
			Layer.effectDiscard(DatabasePostgres.checkStartup).pipe(
				Layer.provideMerge(DatabasePostgres.layer(options)),
			),
		),
	)

/**
 * App connections and authorization. ExecutionLayers adds their workflows.
 */
const layerApps = Layer.mergeAll(Lifecycle.layer, Authorizations.layer).pipe(
	Layer.provideMerge(Connections.layer),
	Layer.provideMerge(ConnectionSessions.layer),
	Layer.provideMerge(AuthorizationCommands.layer),
	Layer.provideMerge(ConnectionCommands.layer),
	Layer.provideMerge(GrantCleanup.layer),
	Layer.provideMerge(AppHost.layer),
	Layer.provide(CatalogDiscovery.layerRules),
	Layer.provideMerge(ConnectionScopes.layer),
	Layer.provide(Layer.merge(ProtocolStores.layer, ActionPolicy.layer)),
)

/**
 * Channels and their connections. A custom Channel calls an
 * address that an administrator chose, so it uses the network of Apps.
 */
const layerChannels = ChannelRegistry.layer.pipe(
	Layer.provideMerge(ChannelQueue.layer),
	Layer.provideMerge(Layer.merge(ChannelInbox.layer, ChannelWatch.layer)),
	Layer.provideMerge(Channels.layer),
)

/** Computers, their providers, pairings and command sessions. */
const layerComputers = ComputerSessions.layer.pipe(
	Layer.provideMerge(Pairings.layer),
	Layer.provideMerge(Computers.layer),
	Layer.provideMerge(ComputerLifecycle.layer),
	Layer.provideMerge(Connectors.layer),
	Layer.provideMerge(ComputerProviders.layer),
)

/** Vaults and the secret providers that they read. */
const layerVaults = Vaults.layer.pipe(Layer.provideMerge(SecretProviders.layer))

/** The Bot records and the context of each Turn. */
const layerBots = BotLayers.layer

/** The App Index, the work that reads App Catalogs into it, and its store. */
const layerIndex = (options: Options) => {
	const indexing = PublicIndexing.layerInspection.pipe(
		Layer.provide(CatalogDiscovery.layerRules),
		Layer.provide(RobotsPolicy.layer),
	)
	const work = IndexWork.layer(options.indexWork).pipe(Layer.provide(indexing))
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
	ModelRegistry.layer(
		options.builtinModels === undefined
			? {}
			: { builtin: options.builtinModels },
	).pipe(
		Layer.provideMerge(
			ProviderOAuth.layer.pipe(Layer.provide(ChatGptOAuth.layer)),
		),
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
 * The application services of OpenBot are built once for the life of the
 * process. Each Turn owns its model and tools. Values from the platform
 * settings, such as the public origin, are read each time they are used, so a
 * change to them needs no new build.
 *
 * It needs the shared services (`layerShared`), the services from outside of
 * OpenBot (`Outside`), the tools of the host (`HostTools`), and the platform
 * services, such as `NodeServices.layer` and `FetchHttpClient.layer`. The
 * services of a layer below are open to each layer above it.
 */
export const layer = (options: Options) =>
	Layer.mergeAll(AppExperience.layer, DeveloperLayers.layer).pipe(
		Layer.provideMerge(
			BetterAuth.layer({
				databaseUrl: options.databaseUrl,
				development: options.development === true,
			}),
		),
		Layer.provideMerge(ResetCommands.layer.pipe(Layer.provideMerge(layerApps))),
		Layer.provideMerge(Triggers.layer),
		Layer.provideMerge(
			Layer.mergeAll(layerChannels, layerComputers, layerVaults),
		),
		Layer.provideMerge(layerBots),
		Layer.provideMerge(layerIndex(options)),
		Layer.provideMerge(Governance.layer),
		Layer.provideMerge(Files.layer.pipe(Layer.provideMerge(FileTasks.layer))),
		Layer.provideMerge(layerAccounts),
		Layer.provideMerge(Access.layer),
		Layer.provideMerge(
			Mail.layer.pipe(Layer.provide(options.mailTransport ?? MailSmtp.layer)),
		),
		Layer.provideMerge(layerModels(options)),
		Layer.provideMerge(
			Layer.mergeAll(
				layerSpending,
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
