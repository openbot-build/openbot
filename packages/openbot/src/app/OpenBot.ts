import * as DeveloperLayers from "../apps/DeveloperLayers.ts"
import * as AppExperience from "../apps/Experience.ts"
import * as Views from "../apps/Views.ts"
import * as AppIndex from "../apps/Index.ts"
import * as Connections from "../apps/Connections.ts"
import * as Lifecycle from "../apps/Lifecycle.ts"
import * as ConnectionLocks from "../apps/ConnectionLocks.ts"
import * as Capabilities from "../apps/Capabilities.ts"
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
	PublicIndexing,
	RobotsPolicy,
	type Network,
} from "@openbot-build/protocol"
import * as OutboundPolicy from "../network/OutboundPolicy.ts"
import * as IndexWork from "../apps/IndexWork.ts"
import * as Governance from "../apps/Governance.ts"
import * as IndexStore from "../apps/IndexStore.ts"
import { IndexNamespace } from "../apps/IndexNamespace.ts"
import { ResolvedConfiguration } from "../auth/Configuration.js"
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
import * as Drivers from "../computers/Drivers.ts"
import * as Pairings from "../computers/Pairings.ts"
import * as ComputerWorker from "../computers/Worker.ts"
import * as Files from "../files/Files.ts"
import * as FileWorker from "../files/Worker.ts"
import * as ComputerPlugin from "../plugins/computers/ComputerPlugin.ts"
import * as Judge from "../capabilities/Judge.ts"
import * as Chats from "../chats/Chats.ts"
import { Config } from "@openbot-build/core"
import * as Backend from "./Backend.ts"
import type { PgClient } from "@effect/sql-pg"
import { NodeServices, NodeCrypto } from "@effect/platform-node"
import { Effect, Layer, type Redacted, Schema, SchemaIssue } from "effect"
import { type Tool } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import * as DatabasePostgres from "../database/DatabasePostgres.ts"
import * as BetterAuth from "../auth/BetterAuth.ts"
import * as TokensPostgres from "../auth/TokensPostgres.ts"
import * as AuditLogPostgres from "../audit/AuditLogPostgres.ts"
import * as OrganizationPostgres from "../organization/OrganizationPostgres.ts"
import * as PlatformAdminsPostgres from "../platform/PlatformAdminsPostgres.ts"
import * as AuthorizationLayer from "../authorization/Layer.ts"
import * as RolesPostgres from "../authorization/RolesPostgres.ts"
import * as ModelRegistry from "../models/ModelRegistry.ts"
import * as BillingPostgres from "../billing/BillingPostgres.ts"
import * as RateLimit from "../billing/RateLimit.ts"
import * as TokenThrottle from "../billing/TokenThrottle.ts"
import * as ModelProvidersPostgres from "../models/ModelProvidersPostgres.ts"
import * as ModelsPostgres from "../models/ModelsPostgres.ts"
import * as SsoPostgres from "../sso/SsoPostgres.ts"
import * as DomainControl from "../apps/DomainControl.ts"
import { Settings } from "../settings/Settings.ts"
import { AuthConfigurationError, type Configuration } from "../auth/Model.js"

export interface Options<
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	BuildE = never,
	BuildR = never,
> {
	readonly databaseUrl: Redacted.Redacted<string>
	readonly indexNamespace?: "public" | "development"
	readonly indexPublicNetwork?: Layer.Layer<Network.PublicNetwork>
	readonly indexWork?: IndexWork.Options
	readonly domainControl?: Layer.Layer<DomainControl.DomainControl>
	readonly appProbe?: Layer.Layer<AppProbe.Probe>
	readonly appNetwork?: Layer.Layer<AppHost.AppNetwork>
	readonly auth: Configuration
	readonly indexSources?: ReadonlyArray<AppIndex.SourceProvider>
	readonly chats?: Omit<Chats.Options<Tools, E, R, BuildE, BuildR>, "namespace">
	/**
	 * Models that the program gives itself, such as the simulated model of
	 * development. Every organization can use them. All other models come from
	 * the model providers that the API stores.
	 */
	readonly builtinModels?: ModelRegistry.Builtin
	readonly triggers?: TriggerWorker.Options
	readonly channels?: ChannelWorker.Options
	readonly computers?: ComputerWorker.Options
	readonly files?: FileWorker.Options
	/** The drivers of the Computer providers. Tests give fake ones. */
	readonly computerDrivers?: Layer.Layer<Drivers.Drivers>
}

/**
 * The services that live as long as the instance, outside of each app:
 * the database pool, the secret keys and the shared settings.
 * A new app after a change to the platform settings uses the same ones.
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

/** The app of one platform configuration, with a separate stored runtime for each member. */
export const layer = <
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	BuildE = never,
	BuildR = never,
>(
	options: Options<Tools, E, R, BuildE, BuildR>,
) => {
	// A Chat names its model. OpenBot never picks one for it.
	const noModel = Effect.fail(
		new Config.ModelConfigurationError({
			reason: "missing",
			message: "The Chat has no model.",
		}),
	)
	/**
	 * Each member gets the models of their organization.
	 * A host that gives its own `resolveModel`, such as a test, keeps it.
	 */
	const chats: Layer.Layer<
		Backend.Backend,
		never,
		| PgClient.PgClient
		| Chats.ExecutionServices<Tools, R>
		| BuildR
		| ModelRegistry.ModelRegistry
		| Settings
	> = Layer.unwrap(
		Effect.gen(function* () {
			const registry = yield* ModelRegistry.ModelRegistry
			const organization = (
				organizationId: string,
			): Chats.OrganizationOptions => ({
				modelCatalog: registry
					.catalog(organizationId)
					.pipe(Effect.orElseSucceed(() => ({ providers: [], models: [] }))),
				resolveModel: (selection) =>
					selection === undefined
						? noModel
						: registry.resolve(organizationId, selection),
			})
			// A runtime without an owner has no organization. It can use only the built-in models.
			const builtin = options.builtinModels
			const fallback =
				builtin === undefined
					? {}
					: {
							modelCatalog: Effect.succeed({
								providers: builtin.providers,
								models: builtin.models,
							}),
							resolveModel: (selection: Config.Selection | undefined) =>
								selection === undefined ? noModel : builtin.resolve(selection),
						}
			return BackendLayers.layer(
				options.chats?.resolveModel === undefined
					? { ...fallback, ...options.chats, organization }
					: options.chats,
			)
		}),
	)

	// Each helper model comes from its own setting of the organization. A host
	// with its own `resolveModel`, such as a test, resolves the setting itself.
	const helper = Layer.effect(
		Judge.HelperModel,
		Effect.gen(function* () {
			const registry = yield* ModelRegistry.ModelRegistry
			const settings = yield* Settings
			const resolve = options.chats?.resolveModel
			// A host with its own `resolveModel` resolves only language models.
			const hosted = (
				organizationId: string,
				name: "rulesModel" | "botMemoryModel",
			) =>
				settings.organization(organizationId).pipe(
					Effect.mapError(
						() =>
							new Config.ModelConfigurationError({
								reason: "unavailable",
								message: "OpenBot cannot read the settings right now.",
							}),
					),
					Effect.flatMap((current) => {
						const selection = current.document[name]
						return selection === null || resolve === undefined
							? Effect.fail(
									new Config.ModelConfigurationError({
										reason: "missing",
										message: `The organization has no ${name}.`,
									}),
								)
							: resolve(selection)
					}),
				)
			const unavailable = (error: Config.ModelConfigurationError) =>
				new Judge.HelperModelUnavailable({ message: error.message })
			return Judge.HelperModel.of({
				rules: (organizationId) =>
					Effect.mapError(
						resolve === undefined
							? registry.rulesModel(organizationId)
							: hosted(organizationId, "rulesModel").pipe(
									Effect.map((model) =>
										ModelRegistry.AnyModel.Language({ model }),
									),
								),
						unavailable,
					),
				botMemory: (organizationId) =>
					Effect.mapError(
						resolve === undefined
							? registry.botMemoryModel(organizationId)
							: hosted(organizationId, "botMemoryModel"),
						unavailable,
					),
			})
		}),
	)
	const bots = BotLayers.layer({ helper })

	// A custom Channel calls an address that an administrator chose, so it uses the
	// same network guard as Apps.
	const channels = ChannelPlugin.layer.pipe(
		Layer.provideMerge(ChannelRegistry.layer),
		Layer.provideMerge(ChannelQueue.layer),
		Layer.provideMerge(Channels.layer),
		Layer.provide(options.appNetwork ?? AppHost.layerNetwork),
	)

	const computers = ComputerPlugin.layer.pipe(
		Layer.provideMerge(Pairings.layer),
		Layer.provideMerge(Computers.layer),
		Layer.provideMerge(Connectors.layer),
		Layer.provideMerge(ComputerProviders.layer),
		Layer.provideMerge(options.computerDrivers ?? Drivers.layer),
	)

	const indexNamespace = options.indexNamespace ?? "public"
	const apps = Layer.mergeAll(
		Lifecycle.layer,
		Authorizations.layer(options.auth.publicOrigin),
		AppPlugin.layer,
		Operations.layer,
	).pipe(
		Layer.provideMerge(CodeRuns.layer),
		Layer.provideMerge(Sandbox.layer),
		Layer.provideMerge(Invocations.layer),
		Layer.provideMerge(Connections.layer),
		Layer.provideMerge(Capabilities.layer),
		Layer.provideMerge(AppHost.layer),
		Layer.provide(CatalogDiscovery.layerRules),
		Layer.provide(options.appProbe ?? AppProbe.layer),
		Layer.provideMerge(AppConnections.layerConnectionScopes),
		Layer.provideMerge(ConnectionLocks.layer),
		Layer.provide(options.appNetwork ?? AppHost.layerNetwork),
		Layer.provide(NodeCrypto.layer),
		Layer.provideMerge(ProtocolStores.layer),
		Layer.provideMerge(ActionPolicy.layer),
	)

	const developer = DeveloperLayers.layer({
		publicOrigin: options.auth.publicOrigin,
		...(options.appNetwork === undefined
			? {}
			: { appNetwork: options.appNetwork }),
		...(options.domainControl === undefined
			? {}
			: { domainControl: options.domainControl }),
		...(options.indexPublicNetwork === undefined
			? {}
			: { publicNetwork: options.indexPublicNetwork }),
	})

	const indexing = PublicIndexing.layer.pipe(
		Layer.provide(CatalogDiscovery.layerRules),
		Layer.provide(RobotsPolicy.layer),
		Layer.provide(
			options.indexPublicNetwork ?? OutboundPolicy.layerPublicNetwork,
		),
		Layer.provide(IndexStore.layer),
	)
	const indexWork = IndexWork.layerWorker(options.indexWork).pipe(
		Layer.provideMerge(
			IndexWork.layer(options.indexWork).pipe(Layer.provide(indexing)),
		),
	)
	const index = Layer.merge(
		AppIndex.layer({
			publicOrigin: options.auth.publicOrigin,
			simulated: indexNamespace === "development",
			...(options.indexSources === undefined
				? {}
				: { providers: options.indexSources }),
		}),
		indexWork,
	).pipe(Layer.provideMerge(IndexStore.layer))

	const base = Layer.merge(
		chats,
		Layer.unwrap(
			Effect.map(
				Schema.decodeEffect(ResolvedConfiguration)(options.auth).pipe(
					Effect.mapError((error) =>
						AuthConfigurationError.make({
							field: SchemaIssue.makeFormatterStandardSchemaV1()(
								error.issue,
							).issues.some((issue) => issue.path?.[0] === "publicOrigin")
								? "publicOrigin"
								: "configuration",
						}),
					),
				),
				(config) =>
					BetterAuth.layer({ ...config, databaseUrl: options.databaseUrl }),
			),
		),
	)
		.pipe(
			Layer.provideMerge(apps),
			Layer.provideMerge(Triggers.layer),
			Layer.provideMerge(Layer.merge(channels, computers)),
			Layer.provideMerge(bots),
			Layer.provideMerge(index),
			Layer.provideMerge(Governance.layer),
			// One pipe takes at most 20 functions, so the rest is in a second pipe.
		)
		.pipe(
			Layer.provideMerge(AuthorizationLayer.layer),
			Layer.provideMerge(TokensPostgres.layer),
			Layer.provideMerge(OrganizationPostgres.layer),
			Layer.provideMerge(PlatformAdminsPostgres.layer),
			Layer.provideMerge(RolesPostgres.layer),
			Layer.provideMerge(
				ModelRegistry.layer(
					options.builtinModels === undefined
						? {}
						: { builtin: options.builtinModels },
				),
			),
			Layer.provideMerge(ModelProvidersPostgres.layer),
			Layer.provideMerge(ModelsPostgres.layer),
			Layer.provideMerge(BillingPostgres.layer),
			Layer.provideMerge(RateLimit.layer),
			Layer.provideMerge(
				Layer.merge(
					TokenThrottle.layer,
					Files.layer.pipe(Layer.provide(NodeCrypto.layer)),
				),
			),
			Layer.provideMerge(
				SsoPostgres.layer.pipe(
					Layer.provide(options.domainControl ?? DomainControl.layer),
				),
			),
			Layer.provideMerge(AuditLogPostgres.layer),
			Layer.provideMerge(Layer.succeed(IndexNamespace, indexNamespace)),
			Layer.provideMerge(
				Layer.merge(NodeServices.layer, FetchHttpClient.layer),
			),
		)
	return Layer.mergeAll(
		Views.layer,
		AppExperience.layer,
		developer,
		Coordinator.layer,
		TriggerWorker.layer(options.triggers),
		ComputerWorker.layer(options.computers),
		FileWorker.layer(options.files),
		ChannelWorker.layer({
			publicOrigin: options.auth.publicOrigin,
			...options.channels,
		}),
	).pipe(Layer.provideMerge(base))
}
