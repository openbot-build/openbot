/** The computers plugin: Computers, their providers, pairings and sessions, and the Computer tools of Bots. */
import { PgClient } from "@effect/sql-pg"
import { Authorization } from "@openbot-build/domain"
import { Layer } from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { Bots } from "@openbot-build/conversation-contract/bots/Bots"
import { BotFeatures } from "@openbot-build/conversation-contract/chats/BotFeatures"
import { WorkAdmission } from "@openbot-build/conversation-contract/chats/WorkAdmission"
import { AuditLog } from "@openbot-build/identity-contract/audit/AuditLog"
import { Calls } from "@openbot-build/server-execution/Calls"
import { Observation } from "@openbot-build/server-execution/Observation"
import { Runner } from "@openbot-build/server-execution/Runner"
import { RunScope } from "@openbot-build/server-execution/RunScope"
import { Access as SendAccess } from "@openbot-build/server-execution/Send"
import { Store } from "@openbot-build/server-execution/Store"
import { Workflows } from "@openbot-build/server-execution/Workflows"
import { Directory } from "@openbot-build/server-execution/Directory"
import { Transport as ResourceTransport } from "@openbot-build/server-execution/Transport"
import { Records } from "@openbot-build/server-kernel/Records"
import { Secrets } from "@openbot-build/server-kernel/Secrets"
import * as Feature from "@openbot-build/server-plugin/Feature"
import { ComputerFiles } from "@openbot-build/apps-contract/computers/ComputerFiles"
import * as ComputerFilesLayer from "./ComputerFiles.ts"
import * as ComputerFeature from "./ComputerFeature.ts"
import * as ComputerProviders from "./ComputerProviders.ts"
import * as Computers from "./Computers.ts"
import * as Connectors from "./Connectors.ts"
import { Drivers } from "@openbot-build/apps-contract/computers/Drivers"
import * as HttpMounts from "./HttpMounts.ts"
import * as Layers from "./Layers.ts"
import * as Lifecycle from "./Lifecycle.ts"
import * as LifecycleWorkflow from "./LifecycleWorkflow.ts"
import * as Maintenance from "./Maintenance.ts"
import * as MaintenanceWorkflow from "./MaintenanceWorkflow.ts"
import * as Pairings from "./Pairings.ts"
import * as Sessions from "./Sessions.ts"
import * as Worker from "./Worker.ts"

/** The keys that this plugin publishes. */
const publishes = [
	ComputerFiles,
	ComputerProviders.ComputerProviders,
	Computers.Computers,
	Connectors.Connectors,
	Lifecycle.Lifecycle,
	Maintenance.Maintenance,
	Pairings.Pairings,
	Sessions.Sessions,
] as const

export default Feature.make("@openbot-build/plugin-computers")
	.stage({
		inject: [
			AuditLog,
			Authorization.Auth,
			Bots,
			Digest.Digest,
			Directory,
			Drivers,
			Observation,
			PgClient.PgClient,
			Records,
			ResourceTransport,
			Secrets,
			SecureRandom.SecureRandom,
			SendAccess,
			SqlClient.SqlClient,
			Store,
			Workflows,
		],
		services: Layer.merge(Maintenance.layer, ComputerFilesLayer.layer).pipe(
			Layer.provideMerge(Layers.layerComputers),
		),
		publishes,
	})
	.start({
		inject: [
			...HttpMounts.inject,
			BotFeatures,
			WorkAdmission,
			Calls,
			RunScope,
			Runner,
		],
		layer: Feature.inOrder(
			ComputerFeature.layer,
			LifecycleWorkflow.layer,
			MaintenanceWorkflow.layer,
			// The worker runs only executions of this plugin.
			Worker.layer,
			HttpMounts.layer,
		),
	})
