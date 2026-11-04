/** The apps plugin: App connections, the App Index, App tools of Bots, and the tools of App developers. */
import { PgClient } from "@effect/sql-pg"
import { Authorization } from "@openbot-build/domain"
import { App, Discovery, Index, Network } from "@openbot-build/protocol"
import { Layer } from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { AppApprovals } from "../apps-contract/apps/AppApprovals.ts"
import { AppCommands } from "../apps-contract/apps/AppCommands.ts"
import { AppNetwork } from "../apps-contract/apps/AppNetwork.ts"
import { IndexWork } from "../apps-contract/apps/IndexWork.ts"
import { CodeCommands } from "../apps-contract/code/CodeCommands.ts"
import { Vaults } from "../apps-contract/vaults/Vaults.ts"
import { Delegations } from "../conversation-contract/bots/Delegations.ts"
import { Gates } from "../conversation-contract/capabilities/Gate.ts"
import { RequestCommands } from "../conversation-contract/capabilities/RequestCommands.ts"
import { Rules } from "../conversation-contract/capabilities/Rules.ts"
import { BotFeatures } from "../conversation-contract/chats/BotFeatures.ts"
import { InputCommands } from "../conversation-contract/chats/InputCommands.ts"
import { OpenWork } from "../conversation-contract/chats/OpenWork.ts"
import { TurnAccess } from "../conversation-contract/chats/TurnAccess.ts"
import { Auth } from "../identity-contract/auth/Auth.ts"
import { ModelRegistry } from "../models-contract/models/ModelRegistry.ts"
import { Calls } from "../server-execution/execution/Calls.ts"
import { Observation } from "../server-execution/execution/Observation.ts"
import { Runner } from "../server-execution/execution/Runner.ts"
import { RunScope } from "../server-execution/execution/RunScope.ts"
import { Store } from "../server-execution/execution/Store.ts"
import { Workflows } from "../server-execution/execution/Workflows.ts"
import { ImportedRecords } from "../server-execution/imported/ImportedRecords.ts"
import { Transport as ResourceTransport } from "../server-execution/resources/Transport.ts"
import { DomainControl } from "../server-kernel/apps/DomainControl.ts"
import { Records } from "../server-kernel/errors/Records.ts"
import { Secrets } from "../server-kernel/secrets/Secrets.ts"
import { Settings } from "../server-kernel/settings/Settings.ts"
import * as Feature from "../server-plugin/Feature.ts"
import * as ActionPolicy from "./ActionPolicy.ts"
import * as AppApprovalsLayer from "./AppApprovals.ts"
import * as AppCommandsLayer from "./AppCommands.ts"
import * as AppFeature from "./AppFeature.ts"
import * as AppHost from "./AppHost.ts"
import * as AppInspections from "./AppInspections.ts"
import * as AppSession from "./AppSession.ts"
import * as AppWorkflow from "./AppWorkflow.ts"
import * as AuthorizationCommands from "./AuthorizationCommands.ts"
import * as Authorizations from "./Authorizations.ts"
import * as AuthorizationWorkflow from "./AuthorizationWorkflow.ts"
import * as ConnectionCommands from "./ConnectionCommands.ts"
import * as Connections from "./Connections.ts"
import * as ConnectionSessions from "./ConnectionSessions.ts"
import * as ConnectionWorkflow from "./ConnectionWorkflow.ts"
import * as DeveloperAccess from "./DeveloperAccess.ts"
import * as DeveloperIndexing from "./DeveloperIndexing.ts"
import * as DeveloperLayers from "./DeveloperLayers.ts"
import * as DeveloperMembers from "./DeveloperMembers.ts"
import * as DeveloperMonitor from "./DeveloperMonitor.ts"
import * as DeveloperMonitorWorkflow from "./DeveloperMonitorWorkflow.ts"
import * as DeveloperNotifications from "./DeveloperNotifications.ts"
import * as DeveloperReports from "./DeveloperReports.ts"
import * as DeveloperTestRuntime from "./DeveloperTestRuntime.ts"
import * as DeveloperTests from "./DeveloperTests.ts"
import * as DeveloperTestStores from "./DeveloperTestStores.ts"
import * as DeveloperWatches from "./DeveloperWatches.ts"
import * as Experience from "./Experience.ts"
import * as Governance from "./Governance.ts"
import * as GrantCleanup from "./GrantCleanup.ts"
import * as GrantCleanupWorkflow from "./GrantCleanupWorkflow.ts"
import * as HttpMounts from "./HttpMounts.ts"
import * as AppIndex from "./Index.ts"
import * as IndexRequestWorkflow from "./IndexRequestWorkflow.ts"
import * as IndexWorkflow from "./IndexWorkflow.ts"
import * as Layers from "./Layers.ts"
import * as Lifecycle from "./Lifecycle.ts"
import * as Probe from "./Probe.ts"
import * as ProofCommands from "./ProofCommands.ts"
import * as ProofWorkflow from "./ProofWorkflow.ts"
import * as ResetCommands from "./ResetCommands.ts"
import * as ResetWorkflow from "./ResetWorkflow.ts"
import * as TestCleanup from "./TestCleanup.ts"
import * as TestCleanupWorkflow from "./TestCleanupWorkflow.ts"
import * as TestCommands from "./TestCommands.ts"
import * as TestWorkflow from "./TestWorkflow.ts"
import * as Views from "./Views.ts"

export const id = "apps"

/** The services of Apps, the App Index and the developer tools. */
const apps = [
	ActionPolicy.ActionPolicy,
	AppApprovals,
	AppCommands,
	AppHost.AppHost,
	AppIndex.PublicIndex,
	AppInspections.AppInspections,
	AuthorizationCommands.AuthorizationCommands,
	Authorizations.Authorizations,
	ConnectionCommands.ConnectionCommands,
	Connections.Connections,
	ConnectionSessions.ConnectionSessions,
	DeveloperAccess.DeveloperAccess,
	DeveloperIndexing.DeveloperIndexing,
	DeveloperMembers.DeveloperMembers,
	DeveloperMonitor.DeveloperMonitor,
	DeveloperNotifications.DeveloperNotifications,
	DeveloperReports.DeveloperReports,
	DeveloperTestRuntime.DeveloperTestRuntime,
	DeveloperTests.DeveloperTests,
	DeveloperTestStores.DeveloperTestStores,
	DeveloperWatches.DeveloperWatches,
	Experience.Experience,
	Governance.Governance,
	GrantCleanup.GrantCleanup,
	Index.IndexStore,
	IndexWork,
	Lifecycle.Lifecycle,
	ProofCommands.ProofCommands,
	ResetCommands.ResetCommands,
	TestCleanup.TestCleanup,
	TestCommands.TestCommands,
	Views.Views,
] as const

/** The keys that this plugin publishes. */
export const publishes = [...apps, AppSession.AppSession] as const

export default Feature.make("@openbot-build/plugin-apps")
	.stage({
		inject: [
			Authorization.Auth,
			Auth,
			Delegations,
			ImportedRecords,
			InputCommands,
			ModelRegistry,
			OpenWork,
			Rules,
			TurnAccess,
			AppNetwork,
			App.ConnectionScopes,
			Digest.Digest,
			Discovery.Discovery,
			DomainControl,
			Observation,
			PgClient.PgClient,
			Probe.Probe,
			Network.PublicNetwork,
			Records,
			ResourceTransport,
			Secrets,
			SecureRandom.SecureRandom,
			Settings,
			SqlClient.SqlClient,
			Store,
		],
		services: Layer.mergeAll(
			Views.layer,
			Experience.layer,
			DeveloperLayers.layer,
		).pipe(
			Layer.provideMerge(
				Layer.merge(AppCommandsLayer.layer, AppApprovalsLayer.layer),
			),
			Layer.provideMerge(ResetCommands.layer),
			Layer.provideMerge(Layers.layerApps),
			Layer.provideMerge(Layers.layerIndex),
			Layer.provideMerge(Governance.layer),
			Layer.provideMerge(ActionPolicy.layer),
		),
		publishes: apps,
	})
	.stage({
		name: "session",
		inject: [CodeCommands, Gates, RequestCommands, Vaults, Calls],
		services: AppSession.layer,
		publishes: [AppSession.AppSession],
	})
	.start({
		inject: [...HttpMounts.inject, BotFeatures, RunScope, Runner, Workflows],
		layer: Feature.inOrder(
			AppFeature.layer,
			AuthorizationWorkflow.layer,
			ConnectionWorkflow.layer,
			DeveloperMonitorWorkflow.layer,
			GrantCleanupWorkflow.layer,
			IndexRequestWorkflow.layer,
			IndexWorkflow.layer,
			ProofWorkflow.layer,
			ResetWorkflow.layer,
			TestCleanupWorkflow.layer,
			TestWorkflow.layer,
			AppWorkflow.layer,
			HttpMounts.layer,
		),
	})
