import * as DeveloperLayers from "../apps/DeveloperLayers.ts"
import type * as DomainControl from "../apps/DomainControl.ts"
import * as AppExperience from "../apps/Experience.ts"
import * as Views from "../apps/Views.ts"
import * as ViewRepository from "../apps/ViewRepositoryPostgres.ts"
import { ViewRepository as ViewRecords } from "../apps/ViewRepository.ts"
import * as AppIndex from "../apps/Index.ts"
import * as Connections from "../apps/Connections.ts"
import * as Lifecycle from "../apps/Lifecycle.ts"
import * as ConnectionLocks from "../apps/ConnectionLocks.ts"
import * as Capabilities from "../apps/Capabilities.ts"
import * as AppPlugin from "../apps/AppPlugin.ts"
import * as Invocations from "../apps/Invocations.ts"
import * as Operations from "../apps/Operations.ts"
import * as InvocationRepository from "../apps/InvocationRepositoryPostgres.ts"
import { InvocationRepository as InvocationRecords } from "../apps/InvocationRepository.ts"
import * as ActionPolicy from "../apps/ActionPolicy.ts"
import * as AppRepositoryPostgres from "../apps/RepositoryPostgres.ts"
import * as AppSecrets from "../apps/Secrets.ts"
import * as AppProbe from "../apps/Probe.ts"
import * as AppHost from "../apps/AppHost.ts"
import * as Authorizations from "../apps/Authorizations.ts"
import * as AuthorizationRepository from "../apps/AuthorizationRepositoryPostgres.ts"
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
import * as IndexWorkRepositoryPostgres from "../apps/IndexWorkRepositoryPostgres.ts"
import * as Governance from "../apps/Governance.ts"
import type { AppIndexApi } from "@openbot-build/api"
import * as IndexRepositoryPostgres from "../apps/IndexRepositoryPostgres.ts"
import { ResolvedConfiguration } from "../auth/Configuration.js"
import * as BackendLayers from "./BackendLayers.ts"
import * as AgentLayers from "../agents/AgentLayers.ts"
import * as Coordinator from "../agents/Coordinator.ts"
import * as Judge from "../capabilities/Judge.ts"
import type { Config } from "@openbot-build/core"
import * as Sessions from "../sessions/Sessions.ts"
import * as Backend from "./Backend.ts"
import { Repository } from "../sessions/Repository.ts"
import { NodeServices, NodeCrypto } from "@effect/platform-node"
import { Effect, Layer, type Redacted, Schema, SchemaIssue } from "effect"
import { LanguageModel, type Tool } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import * as RepositoryPostgres from "../sessions/RepositoryPostgres.ts"
import * as DatabasePostgres from "../database/DatabasePostgres.ts"
import * as BetterAuth from "../auth/BetterAuth.ts"
import * as TokensPostgres from "../auth/TokensPostgres.ts"
import * as AuditLogPostgres from "../audit/AuditLogPostgres.ts"
import * as OrganizationPostgres from "../organization/OrganizationPostgres.ts"
import type * as OrganizationSettings from "../organization/Organization.ts"
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
	readonly appRestrictions?: ReadonlyArray<AppIndexApi.Restriction>
	readonly appReadRules?: ReadonlyArray<ActionPolicy.ReadRule>
	readonly appEncryptionKey: Redacted.Redacted<string>
	readonly appProbe?: Layer.Layer<AppProbe.Probe>
	readonly appNetwork?: Layer.Layer<AppHost.AppNetwork>
	readonly auth: Configuration
	readonly organization?: OrganizationSettings.Options | undefined
	readonly indexSources?: ReadonlyArray<AppIndex.SourceProvider>
	readonly sessions?: Omit<
		Sessions.Options<Tools, E, R, BuildE, BuildR>,
		"namespace"
	>
	readonly agents?: AgentOptions
}

export interface AgentOptions {
	/**
	 * The model that OpenBot uses for its own work: the judge of Rules and Agent memory.
	 * Without it, OpenBot uses the default model of Sessions.
	 */
	readonly helperModel?: Config.Selection
	/** How long a request waits for a decision before it is denied, in milliseconds. */
	readonly requestTimeout?: number
	/** Learn Agent memory after each Turn. It is on by default. */
	readonly memory?: boolean
}

/** Scoped database resources, with a separate stored runtime for each member. */
export const layer = <
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	BuildE = never,
	BuildR = never,
>(
	options: Options<Tools, E, R, BuildE, BuildR>,
) => {
	const checked = Layer.effectDiscard(DatabasePostgres.check).pipe(
		Layer.provideMerge(DatabasePostgres.layer(options)),
	)
	const sessions: Layer.Layer<
		Backend.Backend,
		never,
		Repository | Sessions.ExecutionServices<Tools, R> | BuildR
	> = BackendLayers.layer(options.sessions)

	// The helper model comes from the Session models, or from the model of the host.
	const helper = Layer.effect(
		Judge.HelperModel,
		Effect.gen(function* () {
			const ambient = yield* Effect.serviceOption(LanguageModel.LanguageModel)
			const resolve = options.sessions?.resolveModel
			return Judge.HelperModel.of({
				model: Effect.mapError(
					resolve === undefined
						? Effect.fromOption(ambient).pipe(Effect.mapError(String))
						: resolve(options.agents?.helperModel).pipe(
								Effect.mapError(String),
							),
					() =>
						new Judge.HelperModelUnavailable({
							message: "No helper model is configured.",
						}),
				),
			})
		}),
	)
	const agents = AgentLayers.layer({
		helper,
		...(options.agents?.requestTimeout === undefined
			? {}
			: { requestTimeout: options.agents.requestTimeout }),
	})

	const indexNamespace = options.indexNamespace ?? "public"
	const indexStorage = IndexRepositoryPostgres.layerFor(indexNamespace)
	const appStorage = Layer.mergeAll(
		ProtocolStores.layer,
		AuthorizationRepository.layer,
		InvocationRepository.layer,
		ViewRepository.layer,
	).pipe(
		Layer.provideMerge(AppRepositoryPostgres.layerFor(indexNamespace)),
		Layer.provideMerge(AppSecrets.layer(options.appEncryptionKey)),
	)
	const viewRecovery = Layer.effectDiscard(
		Effect.flatMap(ViewRecords, (records) => records.recover),
	)
	const invocationRecovery = Layer.effectDiscard(
		Effect.flatMap(InvocationRecords, (records) => records.recover),
	)
	const apps = Layer.mergeAll(
		invocationRecovery,
		viewRecovery,
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
		Layer.provideMerge(appStorage),
		Layer.provideMerge(ActionPolicy.layer(options.appReadRules)),
	)

	const developer = DeveloperLayers.layer({
		publicOrigin: options.auth.publicOrigin,
		namespace: indexNamespace,
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
		Layer.provide(
			IndexRepositoryPostgres.layerProtocol.pipe(Layer.provide(indexStorage)),
		),
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
	).pipe(
		Layer.provideMerge(IndexWorkRepositoryPostgres.layerFor(indexNamespace)),
		Layer.provideMerge(indexStorage),
	)

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
		Layer.provideMerge(agents),
		Layer.provideMerge(index),
		Layer.provideMerge(Governance.layer(options.appRestrictions)),
		Layer.provideMerge(TokensPostgres.layer),
		Layer.provideMerge(OrganizationPostgres.layer(options.organization)),
		Layer.provideMerge(AuditLogPostgres.layer),
		Layer.provideMerge(RepositoryPostgres.layer),
		Layer.provideMerge(checked),
		Layer.provideMerge(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
	)
	return Layer.mergeAll(
		Views.layer,
		AppExperience.layer,
		developer,
		Coordinator.layer(
			options.agents?.memory === undefined
				? {}
				: { memory: options.agents.memory },
		),
	).pipe(Layer.provideMerge(base))
}
