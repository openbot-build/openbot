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
import * as ProtocolNodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import * as IndexWork from "../apps/IndexWork.ts"
import * as Governance from "../apps/Governance.ts"
import * as IndexStore from "../apps/IndexStore.ts"
import { IndexNamespace } from "../apps/IndexNamespace.ts"
import { ResolvedConfiguration } from "../auth/Configuration.js"
import * as BackendLayers from "./BackendLayers.ts"
import * as AgentLayers from "../agents/AgentLayers.ts"
import * as Coordinator from "../agents/Coordinator.ts"
import * as WorkflowLayers from "../workflows/WorkflowLayers.ts"
import type * as WorkflowWorker from "../workflows/Worker.ts"
import * as Judge from "../capabilities/Judge.ts"
import * as Sessions from "../sessions/Sessions.ts"
import { Config } from "@openbot-build/core"
import * as Backend from "./Backend.ts"
import type { PgClient } from "@effect/sql-pg"
import { NodeServices, NodeCrypto } from "@effect/platform-node"
import {
	Effect,
	Layer,
	Option,
	type Redacted,
	Schema,
	SchemaIssue,
} from "effect"
import { type Tool } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import * as DatabasePostgres from "../database/DatabasePostgres.ts"
import * as BetterAuth from "../auth/BetterAuth.ts"
import * as TokensPostgres from "../auth/TokensPostgres.ts"
import * as AuditLogPostgres from "../audit/AuditLogPostgres.ts"
import * as OrganizationPostgres from "../organization/OrganizationPostgres.ts"
import * as PlatformAdminsPostgres from "../platform/PlatformAdminsPostgres.ts"
import * as RolesPostgres from "../authorization/RolesPostgres.ts"
import * as ModelRegistry from "../models/ModelRegistry.ts"
import * as ModelProvidersPostgres from "../models/ModelProvidersPostgres.ts"
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
	readonly sessions?: Omit<
		Sessions.Options<Tools, E, R, BuildE, BuildR>,
		"namespace"
	>
	/**
	 * Models that the program gives itself, such as the simulated model of
	 * development. Every organization can use them. All other models come from
	 * the model providers that the API stores.
	 */
	readonly builtinModels?: ModelRegistry.Builtin
	readonly workflows?: WorkflowWorker.Options
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
	/**
	 * Each member gets the models and memory switches of their organization.
	 * A host that gives its own `resolveModel`, such as a test, keeps it.
	 */
	const sessions: Layer.Layer<
		Backend.Backend,
		never,
		| PgClient.PgClient
		| Sessions.ExecutionServices<Tools, R>
		| BuildR
		| ModelRegistry.ModelRegistry
		| Settings
	> = Layer.unwrap(
		Effect.gen(function* () {
			const registry = yield* ModelRegistry.ModelRegistry
			const settings = yield* Settings
			const organization = (
				organizationId: string,
			): Sessions.OrganizationOptions => ({
				modelCatalog: registry
					.catalog(organizationId)
					.pipe(Effect.orElseSucceed(() => ({ providers: [], models: [] }))),
				defaults: registry.defaultSelection(organizationId).pipe(
					Effect.map(
						Option.match({
							onNone: () => ({}),
							onSome: (model) => ({ model }),
						}),
					),
					Effect.orElseSucceed(() => ({})),
				),
				resolveModel: (selection) =>
					registry.resolve(organizationId, selection),
				memoryDefaults: settings.organization(organizationId).pipe(
					Effect.map((current) => current.document.memory),
					Effect.orElseSucceed(() => ({})),
				),
			})
			// A runtime without an owner has no organization. It can use only the built-in models.
			const builtin = options.builtinModels
			const first = builtin?.models[0]
			const fallback =
				builtin === undefined || first === undefined
					? {}
					: {
							modelCatalog: Effect.succeed({
								providers: builtin.providers,
								models: builtin.models,
							}),
							defaults: Effect.succeed({
								model: Config.Selection.make({
									provider: first.provider,
									model: first.id,
								}),
							}),
							resolveModel: (selection: Config.Selection | undefined) =>
								builtin.resolve(
									selection ??
										Config.Selection.make({
											provider: first.provider,
											model: first.id,
										}),
								),
						}
			return BackendLayers.layer(
				options.sessions?.resolveModel === undefined
					? { ...fallback, ...options.sessions, organization }
					: options.sessions,
			)
		}),
	)

	// The helper model comes from the settings of the organization, or from the model of the host.
	const helper = Layer.effect(
		Judge.HelperModel,
		Effect.gen(function* () {
			const registry = yield* ModelRegistry.ModelRegistry
			const resolve = options.sessions?.resolveModel
			return Judge.HelperModel.of({
				model: (organizationId) =>
					Effect.mapError(
						resolve === undefined
							? registry.helper(organizationId)
							: resolve(undefined),
						(error) =>
							new Judge.HelperModelUnavailable({ message: error.message }),
					),
			})
		}),
	)
	const agents = AgentLayers.layer({ helper })

	const indexNamespace = options.indexNamespace ?? "public"
	const apps = Layer.mergeAll(
		Lifecycle.layer,
		Authorizations.layer(options.auth.publicOrigin),
		AppPlugin.layer,
		Operations.layer,
	).pipe(
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
			options.indexPublicNetwork ?? ProtocolNodeHttpServer.layerPublicNetwork(),
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
		sessions,
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
	).pipe(
		Layer.provideMerge(apps),
		Layer.provideMerge(WorkflowLayers.layerServices),
		Layer.provideMerge(agents),
		Layer.provideMerge(index),
		Layer.provideMerge(Governance.layer),
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
		Layer.provideMerge(
			SsoPostgres.layer.pipe(
				Layer.provide(options.domainControl ?? DomainControl.layer),
			),
		),
		Layer.provideMerge(AuditLogPostgres.layer),
		Layer.provideMerge(Layer.succeed(IndexNamespace, indexNamespace)),
		Layer.provideMerge(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
	)
	return Layer.mergeAll(
		Views.layer,
		AppExperience.layer,
		developer,
		Coordinator.layer,
		WorkflowLayers.layerWorkers(options.workflows),
	).pipe(Layer.provideMerge(base))
}
