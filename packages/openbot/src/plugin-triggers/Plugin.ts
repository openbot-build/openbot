/** The triggers plugin: Triggers that start Turns, and their webhooks. */
import { Authorization } from "@openbot-build/domain"
import { Digest, SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { Bots } from "../conversation-contract/bots/Bots.ts"
import { Delegations } from "../conversation-contract/bots/Delegations.ts"
import { TurnAccess } from "../conversation-contract/chats/TurnAccess.ts"
import { AuditLog } from "@openbot-build/identity-contract/audit/AuditLog"
import { ModelRegistry } from "../models-contract/models/ModelRegistry.ts"
import { Runner } from "@openbot-build/server-execution/execution/Runner"
import { RunScope } from "@openbot-build/server-execution/execution/RunScope"
import { Store } from "@openbot-build/server-execution/execution/Store"
import { Workflows } from "@openbot-build/server-execution/execution/Workflows"
import { Records } from "@openbot-build/server-kernel/errors/Records"
import { Secrets } from "@openbot-build/server-kernel/secrets/Secrets"
import { Settings } from "@openbot-build/server-kernel/settings/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
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
