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
import { Tokens } from "@openbot-build/identity-contract/auth/Tokens"
import { Organization } from "@openbot-build/identity-contract/organization/Organization"
import { ModelRegistry } from "../models-contract/models/ModelRegistry.ts"
import { Billing } from "@openbot-build/server-billing/billing/Billing"
import { Calls } from "@openbot-build/server-execution/execution/Calls"
import { Commands } from "@openbot-build/server-execution/execution/Commands"
import { Observation } from "@openbot-build/server-execution/execution/Observation"
import { Runner } from "@openbot-build/server-execution/execution/Runner"
import { RunScope } from "@openbot-build/server-execution/execution/RunScope"
import { Access as SendAccess } from "@openbot-build/server-execution/execution/Send"
import { Store } from "@openbot-build/server-execution/execution/Store"
import { Workflows } from "@openbot-build/server-execution/execution/Workflows"
import { ImportedRecords } from "@openbot-build/server-execution/imported/ImportedRecords"
import { Directory } from "@openbot-build/server-execution/resources/Directory"
import { Transport as ResourceTransport } from "@openbot-build/server-execution/resources/Transport"
import { Records } from "@openbot-build/server-kernel/errors/Records"
import { Settings } from "@openbot-build/server-kernel/settings/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
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
