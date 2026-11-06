/** The apps plugin: App connections, the App Index, App tools of Bots, and the tools of App developers. */
import { IndexStore } from "@openbot-build/protocol"
import { PgClient } from "@effect/sql-pg"
import { Authorization } from "@openbot-build/domain"
import { App, Discovery, Network } from "@openbot-build/protocol"
import { Layer } from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { AppCommands } from "@openbot-build/apps-contract/apps/AppCommands"
import { AppNetwork } from "@openbot-build/apps-contract/apps/AppNetwork"
import { IndexWork } from "@openbot-build/apps-contract/apps/IndexWork"
import { CodeCommands } from "@openbot-build/apps-contract/code/CodeCommands"
import { Vaults } from "@openbot-build/apps-contract/vaults/Vaults"
import { Delegations } from "@openbot-build/conversation-contract/bots/Delegations"
import { Gates } from "@openbot-build/conversation-contract/capabilities/Gate"
import { RequestCommands } from "@openbot-build/conversation-contract/capabilities/RequestCommands"
import { Rules } from "@openbot-build/conversation-contract/capabilities/Rules"
import { BotFeatures } from "@openbot-build/conversation-contract/chats/BotFeatures"
import { InputCommands } from "@openbot-build/conversation-contract/chats/InputCommands"
import { OpenWork } from "@openbot-build/conversation-contract/chats/OpenWork"
import { TurnAccess } from "@openbot-build/conversation-contract/chats/TurnAccess"
import { Auth } from "@openbot-build/identity-contract/auth/Auth"
import { ModelRegistry } from "@openbot-build/models-contract/ModelRegistry"
import { Calls } from "@openbot-build/server-execution/Calls"
import { Observation } from "@openbot-build/server-execution/Observation"
import { Runner } from "@openbot-build/server-execution/Runner"
import { RunScope } from "@openbot-build/server-execution/RunScope"
import { Store } from "@openbot-build/server-execution/Store"
import { Workflows } from "@openbot-build/server-execution/Workflows"
import { Transport as ResourceTransport } from "@openbot-build/server-execution/Transport"
import { DomainControl } from "@openbot-build/server-kernel/DomainControl"
import { InstanceSettings } from "@openbot-build/server-kernel/InstanceSettings"
import { Records } from "@openbot-build/server-kernel/Records"
import { Secrets } from "@openbot-build/server-kernel/Secrets"
import { Settings } from "@openbot-build/server-kernel/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
import * as ActionPolicy from "./ActionPolicy.ts"
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
import * as AppIndex from "./AppIndex.ts"
import * as IndexRequestWorkflow from "./IndexRequestWorkflow.ts"
import * as IndexWorkflow from "./IndexWorkflow.ts"
import * as IndexTiming from "./IndexWork.ts"
import * as Layers from "./Layers.ts"
import * as Lifecycle from "./Lifecycle.ts"
import { Probe } from "@openbot-build/apps-contract/apps/Probe"
import * as ProofCommands from "./ProofCommands.ts"
import * as ProofWorkflow from "./ProofWorkflow.ts"
import * as ResetCommands from "./ResetCommands.ts"
import * as ResetWorkflow from "./ResetWorkflow.ts"
import * as TestCleanup from "./TestCleanup.ts"
import * as TestCleanupWorkflow from "./TestCleanupWorkflow.ts"
import * as TestCommands from "./TestCommands.ts"
import * as TestWorkflow from "./TestWorkflow.ts"
import * as Views from "./Views.ts"

/** The services of Apps, the App Index and the developer tools. */
const apps = [
	ActionPolicy.ActionPolicy,
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
	IndexStore.IndexStore,
	IndexWork,
	Lifecycle.Lifecycle,
	ProofCommands.ProofCommands,
	ResetCommands.ResetCommands,
	TestCleanup.TestCleanup,
	TestCommands.TestCommands,
	Views.Views,
] as const

export default Feature.make("@openbot-build/plugin-apps", {
	config: { schema: IndexTiming.Config, key: IndexTiming.Timing },
})
	.stage({
		inject: [
			Authorization.Auth,
			Auth,
			Delegations,
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
			InstanceSettings,
			Observation,
			PgClient.PgClient,
			Probe,
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
			Layer.provideMerge(AppCommandsLayer.layer),
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
