/** The triggers plugin: Triggers that start Turns, and their webhooks. */
import { Authorization } from "@openbot-build/domain"
import { Digest, SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { Bots } from "../conversation-contract/bots/Bots.ts"
import { Delegations } from "../conversation-contract/bots/Delegations.ts"
import { TurnAccess } from "../conversation-contract/chats/TurnAccess.ts"
import { AuditLog } from "../identity-contract/audit/AuditLog.ts"
import { ModelRegistry } from "../models-contract/models/ModelRegistry.ts"
import { Runner } from "../server-execution/execution/Runner.ts"
import { RunScope } from "../server-execution/execution/RunScope.ts"
import { Store } from "../server-execution/execution/Store.ts"
import { Workflows } from "../server-execution/execution/Workflows.ts"
import { Records } from "../server-kernel/errors/Records.ts"
import { Secrets } from "../server-kernel/secrets/Secrets.ts"
import { Settings } from "../server-kernel/settings/Settings.ts"
import * as Feature from "../server-plugin/Feature.ts"
import * as HttpMounts from "./HttpMounts.ts"
import * as Triggers from "./Triggers.ts"
import * as TriggerWorkflow from "./Workflow.ts"

export const id = "triggers"

/** The keys that this plugin publishes. */
export const publishes = [Triggers.Triggers] as const

export default Feature.make("@openbot-build/plugin-triggers")
	.stage({
		inject: [
			Authorization.Auth,
			Digest.Digest,
			Secrets,
			SecureRandom.SecureRandom,
			SqlClient.SqlClient,
			Store,
		],
		services: Triggers.layer,
		publishes,
	})
	.start({
		inject: [
			...HttpMounts.inject,
			AuditLog,
			Bots,
			Delegations,
			ModelRegistry,
			TurnAccess,
			Records,
			RunScope,
			Runner,
			Settings,
			Workflows,
		],
		layer: Feature.inOrder(TriggerWorkflow.layer, HttpMounts.layer),
	})
