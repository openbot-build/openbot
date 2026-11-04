/** The computers plugin: Computers, their providers, pairings and sessions, and the Computer tools of Bots. */
import { PgClient } from "@effect/sql-pg"
import { Authorization } from "@openbot-build/domain"
import { Layer } from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { Bots } from "../conversation-contract/bots/Bots.ts"
import { BotFeatures } from "../conversation-contract/chats/BotFeatures.ts"
import { WorkAdmission } from "../conversation-contract/chats/WorkAdmission.ts"
import { AuditLog } from "../identity-contract/audit/AuditLog.ts"
import { Calls } from "../server-execution/execution/Calls.ts"
import { Observation } from "../server-execution/execution/Observation.ts"
import { Runner } from "../server-execution/execution/Runner.ts"
import { RunScope } from "../server-execution/execution/RunScope.ts"
import { Access as SendAccess } from "../server-execution/execution/Send.ts"
import { Store } from "../server-execution/execution/Store.ts"
import { Workflows } from "../server-execution/execution/Workflows.ts"
import { Directory } from "../server-execution/resources/Directory.ts"
import { Transport as ResourceTransport } from "../server-execution/resources/Transport.ts"
import { Records } from "../server-kernel/errors/Records.ts"
import { Secrets } from "../server-kernel/secrets/Secrets.ts"
import * as Feature from "../server-plugin/Feature.ts"
import * as ComputerFeature from "./ComputerFeature.ts"
import * as ComputerProviders from "./ComputerProviders.ts"
import * as Computers from "./Computers.ts"
import * as Connectors from "./connector/Connectors.ts"
import { Drivers } from "./Drivers.ts"
import * as HttpMounts from "./HttpMounts.ts"
import * as Layers from "./Layers.ts"
import * as Lifecycle from "./Lifecycle.ts"
import * as LifecycleWorkflow from "./LifecycleWorkflow.ts"
import * as Maintenance from "./Maintenance.ts"
import * as MaintenanceWorkflow from "./MaintenanceWorkflow.ts"
import * as Pairings from "./Pairings.ts"
import * as Sessions from "./Sessions.ts"
import * as Worker from "./Worker.ts"

export const id = "computers"

/** The keys that this plugin publishes. */
export const publishes = [
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
		services: Maintenance.layer.pipe(Layer.provideMerge(Layers.layerComputers)),
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
