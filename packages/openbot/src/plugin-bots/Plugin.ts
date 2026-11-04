/** The bots plugin: Bots, their memory, and the delegations between them. */
import { PgClient } from "@effect/sql-pg"
import { Authorization } from "@openbot-build/domain"
import { Layer } from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { BotRecords } from "../conversation-contract/bots/BotRecords.ts"
import { Bots } from "../conversation-contract/bots/Bots.ts"
import { DelegationQueries } from "../conversation-contract/bots/DelegationQueries.ts"
import { Delegations } from "../conversation-contract/bots/Delegations.ts"
import { MemoryBot } from "../conversation-contract/bots/MemoryBot.ts"
import { Gates } from "../conversation-contract/capabilities/Gate.ts"
import { Grants } from "../conversation-contract/capabilities/Grants.ts"
import { RequestCommands } from "../conversation-contract/capabilities/RequestCommands.ts"
import { Requests } from "../conversation-contract/capabilities/Requests.ts"
import { Rules } from "../conversation-contract/capabilities/Rules.ts"
import { BotFeatures } from "../conversation-contract/chats/BotFeatures.ts"
import { InputCommands } from "../conversation-contract/chats/InputCommands.ts"
import { OpenWork } from "../conversation-contract/chats/OpenWork.ts"
import { TurnAccess } from "../conversation-contract/chats/TurnAccess.ts"
import { WorkAdmission } from "../conversation-contract/chats/WorkAdmission.ts"
import { Reminders } from "../conversation-contract/work/Reminders.ts"
import { AuditLog } from "../identity-contract/audit/AuditLog.ts"
import { Mail } from "../identity-contract/mail/Mail.ts"
import { Organization } from "../identity-contract/organization/Organization.ts"
import { ModelRegistry } from "../models-contract/models/ModelRegistry.ts"
import { Billing } from "../server-billing/billing/Billing.ts"
import { Calls } from "../server-execution/execution/Calls.ts"
import { Commands } from "../server-execution/execution/Commands.ts"
import { Observation } from "../server-execution/execution/Observation.ts"
import { Runner } from "../server-execution/execution/Runner.ts"
import { RunScope } from "../server-execution/execution/RunScope.ts"
import { Store } from "../server-execution/execution/Store.ts"
import { Workflows } from "../server-execution/execution/Workflows.ts"
import { ImportedRecords } from "../server-execution/imported/ImportedRecords.ts"
import { Records } from "../server-kernel/errors/Records.ts"
import { Secrets } from "../server-kernel/secrets/Secrets.ts"
import { Settings } from "../server-kernel/settings/Settings.ts"
import * as Feature from "../server-plugin/Feature.ts"
import * as BotFeature from "./BotFeature.ts"
import * as BotMemories from "./BotMemories.ts"
import * as BotRecordsLayer from "./BotRecords.ts"
import * as BotsLayer from "./Bots.ts"
import * as DelegationCommands from "./DelegationCommands.ts"
import * as DelegationNotices from "./DelegationNotices.ts"
import * as DelegationNoticeWorkflow from "./DelegationNoticeWorkflow.ts"
import * as DelegationQueriesLayer from "./DelegationQueries.ts"
import * as DelegationsLayer from "./Delegations.ts"
import * as DelegationSession from "./DelegationSession.ts"
import * as DelegationWorkflow from "./DelegationWorkflow.ts"
import * as HttpMounts from "./HttpMounts.ts"
import * as MemoryBotLayer from "./MemoryBot.ts"
import * as MemoryLearning from "./MemoryLearning.ts"
import * as MemoryLogs from "./MemoryLogs.ts"
import * as MemoryModels from "./MemoryModels.ts"
import * as MemoryTasks from "./MemoryTasks.ts"
import * as MemoryWorkflow from "./MemoryWorkflow.ts"
import * as OpenWorkCount from "./OpenWorkCount.ts"

export const id = "bots"

/** The records of Bots and their memory. */
const records = [
	BotMemories.BotMemories,
	BotRecords,
	Delegations,
	MemoryBot,
	MemoryLogs.MemoryLogs,
] as const

/** Bots, the count of open work, and the models and tasks of memory. */
const bots = [
	Bots,
	MemoryModels.MemoryModels,
	MemoryTasks.MemoryTasks,
	OpenWork,
] as const

/** The commands, sessions and notices of delegations, and memory learning. */
const delegations = [
	DelegationCommands.DelegationCommands,
	DelegationNotices.DelegationNotices,
	DelegationQueries,
	DelegationSession.DelegationSession,
	MemoryLearning.MemoryLearning,
] as const

/** The keys that this plugin publishes. */
export const publishes = [...records, ...bots, ...delegations] as const

export default Feature.make("@openbot-build/plugin-bots")
	.stage({
		inject: [
			Digest.Digest,
			PgClient.PgClient,
			Secrets,
			SecureRandom.SecureRandom,
		],
		services: Layer.mergeAll(
			MemoryBotLayer.layer,
			DelegationsLayer.layer,
			BotMemories.layer,
		).pipe(
			Layer.provideMerge(Layer.merge(BotRecordsLayer.layer, MemoryLogs.layer)),
		),
		publishes: records,
	})
	.stage({
		name: "bots",
		inject: [
			Authorization.Auth,
			ModelRegistry,
			Reminders,
			Requests,
			Billing,
			Calls,
			Observation,
			Records,
			SqlClient.SqlClient,
			Store,
		],
		services: Layer.mergeAll(
			BotsLayer.layer,
			OpenWorkCount.layer,
			MemoryTasks.layer,
		).pipe(Layer.provideMerge(MemoryModels.layer)),
		publishes: bots,
	})
	.stage({
		name: "delegations",
		inject: [
			Commands,
			Gates,
			ImportedRecords,
			InputCommands,
			RequestCommands,
			Settings,
			TurnAccess,
		],
		services: Layer.mergeAll(
			DelegationSession.layer,
			DelegationNotices.layer,
			DelegationQueriesLayer.layer,
			MemoryLearning.layer,
		).pipe(Layer.provideMerge(DelegationCommands.layer)),
		publishes: delegations,
	})
	.start({
		inject: [
			...HttpMounts.inject,
			AuditLog,
			BotFeatures,
			Grants,
			Mail,
			Organization,
			Rules,
			RunScope,
			Runner,
			WorkAdmission,
			Workflows,
		],
		layer: Feature.inOrder(
			BotFeature.layer,
			DelegationWorkflow.layer,
			DelegationNoticeWorkflow.layer,
			MemoryWorkflow.layer,
			HttpMounts.layer,
		),
	})
