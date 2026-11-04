/** The chats plugin: Chats, Turns, tools, and Live connections. */
import { PgClient } from "@effect/sql-pg"
import { Authorization } from "@openbot-build/domain"
import { Layer } from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { Files } from "../apps-contract/files/Files.ts"
import { Bots } from "../conversation-contract/bots/Bots.ts"
import { DelegationQueries } from "../conversation-contract/bots/DelegationQueries.ts"
import { Delegations } from "../conversation-contract/bots/Delegations.ts"
import { MemoryBot } from "../conversation-contract/bots/MemoryBot.ts"
import { Gates } from "../conversation-contract/capabilities/Gate.ts"
import { Requests } from "../conversation-contract/capabilities/Requests.ts"
import { ReviewTools } from "../conversation-contract/capabilities/ReviewTools.ts"
import { Channels } from "../conversation-contract/channels/Channels.ts"
import { BotFeatures } from "../conversation-contract/chats/BotFeatures.ts"
import { InputCommands } from "../conversation-contract/chats/InputCommands.ts"
import { OpenWork } from "../conversation-contract/chats/OpenWork.ts"
import { ToolCommands } from "../conversation-contract/chats/ToolCommands.ts"
import { TurnAccess } from "../conversation-contract/chats/TurnAccess.ts"
import { TurnContext } from "../conversation-contract/chats/TurnContext.ts"
import { WorkAdmission } from "../conversation-contract/chats/WorkAdmission.ts"
import { Tokens } from "../identity-contract/auth/Tokens.ts"
import { Organization } from "../identity-contract/organization/Organization.ts"
import { ModelRegistry } from "../models-contract/models/ModelRegistry.ts"
import { Billing } from "../server-billing/billing/Billing.ts"
import { Calls } from "../server-execution/execution/Calls.ts"
import { Commands } from "../server-execution/execution/Commands.ts"
import { Observation } from "../server-execution/execution/Observation.ts"
import { Runner } from "../server-execution/execution/Runner.ts"
import { RunScope } from "../server-execution/execution/RunScope.ts"
import { Access as SendAccess } from "../server-execution/execution/Send.ts"
import { Store } from "../server-execution/execution/Store.ts"
import { Workflows } from "../server-execution/execution/Workflows.ts"
import { ImportedRecords } from "../server-execution/imported/ImportedRecords.ts"
import { Directory } from "../server-execution/resources/Directory.ts"
import { Transport as ResourceTransport } from "../server-execution/resources/Transport.ts"
import { Records } from "../server-kernel/errors/Records.ts"
import { Settings } from "../server-kernel/settings/Settings.ts"
import * as Feature from "../server-plugin/Feature.ts"
import { HostTools } from "../tools-contract/chats/HostTools.ts"
import * as ChatControlWorkflow from "./ChatControlWorkflow.ts"
import * as ExecutionFeatures from "./ExecutionFeatures.ts"
import * as HttpMounts from "./HttpMounts.ts"
import * as InputCommandsLayer from "./InputCommands.ts"
import * as LiveConnections from "./live/LiveConnections.ts"
import * as ToolCommandsLayer from "./ToolCommands.ts"
import * as ToolControls from "./ToolControls.ts"
import * as ToolNotices from "./ToolNotices.ts"
import * as ToolNoticeWorkflow from "./ToolNoticeWorkflow.ts"
import * as ToolSession from "./ToolSession.ts"
import * as ToolSteps from "./ToolSteps.ts"
import * as ToolWorkflow from "./ToolWorkflow.ts"
import * as TurnAccessLayer from "./TurnAccess.ts"
import * as TurnContextLayer from "./TurnContext.ts"
import * as TurnSession from "./TurnSession.ts"
import * as TurnTools from "./TurnTools.ts"
import * as TurnWorkflow from "./TurnWorkflow.ts"
import * as WorkAdmissionLayer from "./WorkAdmission.ts"

export const id = "chats"

/** The context, tools, commands and access rules of Turns. */
const turnParts = [
	InputCommands,
	LiveConnections.LiveConnections,
	ToolCommands,
	ToolControls.ToolControls,
	ToolNotices.ToolNotices,
	ToolSteps.ToolSteps,
	TurnAccess,
	TurnContext,
	TurnTools.TurnTools,
	WorkAdmission,
] as const

/** The sessions of Turns and tools. */
const turns = [
	ExecutionFeatures.ExecutionFeatures,
	ToolSession.ToolSession,
	TurnSession.TurnSession,
] as const

/** The keys that this plugin publishes. */
export const publishes = [...turnParts, ...turns] as const

export default Feature.make("@openbot-build/plugin-chats")
	.stage({
		inject: [
			Authorization.Auth,
			Bots,
			Channels,
			Delegations,
			Organization,
			Requests,
			Tokens,
			Calls,
			Digest.Digest,
			Directory,
			Observation,
			PgClient.PgClient,
			Records,
			ResourceTransport,
			SecureRandom.SecureRandom,
			SendAccess,
			SqlClient.SqlClient,
			Store,
			Workflows,
		],
		services: Layer.mergeAll(
			ToolNotices.layer,
			TurnTools.layer,
			ToolControls.layer,
			LiveConnections.layer,
		).pipe(
			Layer.provideMerge(
				Layer.mergeAll(
					ToolSteps.layer,
					InputCommandsLayer.layer,
					ToolCommandsLayer.layer,
				),
			),
			Layer.provideMerge(
				Layer.merge(TurnAccessLayer.layer, WorkAdmissionLayer.layer),
			),
			Layer.provideMerge(TurnContextLayer.layer),
		),
		publishes: turnParts,
	})
	.stage({
		name: "turns",
		inject: [
			DelegationQueries,
			Files,
			Gates,
			ImportedRecords,
			MemoryBot,
			ModelRegistry,
			OpenWork,
			ReviewTools,
			Billing,
			BotFeatures,
			Commands,
			HostTools,
			Settings,
		],
		services: Layer.merge(TurnSession.layer, ToolSession.layer).pipe(
			Layer.provideMerge(ExecutionFeatures.layer),
		),
		publishes: turns,
	})
	.start({
		inject: [...HttpMounts.inject, RunScope, Runner],
		layer: Feature.inOrder(
			ChatControlWorkflow.layer,
			ToolNoticeWorkflow.layer,
			TurnWorkflow.layer,
			ToolWorkflow.layer,
			HttpMounts.layer,
		),
	})
