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
import { AuditLog } from "@openbot-build/identity-contract/audit/AuditLog"
import { Mail } from "@openbot-build/identity-contract/mail/Mail"
import { Organization } from "@openbot-build/identity-contract/organization/Organization"
import { ModelRegistry } from "../models-contract/models/ModelRegistry.ts"
import { Billing } from "@openbot-build/server-billing/billing/Billing"
import { Calls } from "@openbot-build/server-execution/execution/Calls"
import { Commands } from "@openbot-build/server-execution/execution/Commands"
import { Observation } from "@openbot-build/server-execution/execution/Observation"
import { Runner } from "@openbot-build/server-execution/execution/Runner"
import { RunScope } from "@openbot-build/server-execution/execution/RunScope"
import { Store } from "@openbot-build/server-execution/execution/Store"
import { Workflows } from "@openbot-build/server-execution/execution/Workflows"
import { ImportedRecords } from "@openbot-build/server-execution/imported/ImportedRecords"
import { Records } from "@openbot-build/server-kernel/errors/Records"
import { Secrets } from "@openbot-build/server-kernel/secrets/Secrets"
import { Settings } from "@openbot-build/server-kernel/settings/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
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
