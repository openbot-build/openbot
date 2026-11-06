/** The chats plugin: Chats, Turns, tools, and Live connections. */
import { PgClient } from "@effect/sql-pg"
import { Authorization } from "@openbot-build/domain"
import { Layer } from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { Files } from "@openbot-build/apps-contract/files/Files"
import { Bots } from "@openbot-build/conversation-contract/bots/Bots"
import { DelegationQueries } from "@openbot-build/conversation-contract/bots/DelegationQueries"
import { Delegations } from "@openbot-build/conversation-contract/bots/Delegations"
import { MemoryBot } from "@openbot-build/conversation-contract/bots/MemoryBot"
import { Gates } from "@openbot-build/conversation-contract/capabilities/Gate"
import { Requests } from "@openbot-build/conversation-contract/capabilities/Requests"
import { ReviewTools } from "@openbot-build/conversation-contract/capabilities/ReviewTools"
import { Channels } from "@openbot-build/conversation-contract/channels/Channels"
import { BotFeatures } from "@openbot-build/conversation-contract/chats/BotFeatures"
import { InputCommands } from "@openbot-build/conversation-contract/chats/InputCommands"
import { OpenWork } from "@openbot-build/conversation-contract/chats/OpenWork"
import { ToolCommands } from "@openbot-build/conversation-contract/chats/ToolCommands"
import { TurnAccess } from "@openbot-build/conversation-contract/chats/TurnAccess"
import { TurnContext } from "@openbot-build/conversation-contract/chats/TurnContext"
import { WorkAdmission } from "@openbot-build/conversation-contract/chats/WorkAdmission"
import { Tokens } from "@openbot-build/identity-contract/auth/Tokens"
import { Organization } from "@openbot-build/identity-contract/organization/Organization"
import { ModelRegistry } from "@openbot-build/models-contract/ModelRegistry"
import { Billing } from "@openbot-build/server-billing/Billing"
import { Calls } from "@openbot-build/server-execution/Calls"
import { Commands } from "@openbot-build/server-execution/Commands"
import { Observation } from "@openbot-build/server-execution/Observation"
import { Runner } from "@openbot-build/server-execution/Runner"
import { RunScope } from "@openbot-build/server-execution/RunScope"
import { Access as SendAccess } from "@openbot-build/server-execution/Send"
import { Store } from "@openbot-build/server-execution/Store"
import { Workflows } from "@openbot-build/server-execution/Workflows"
import { Directory } from "@openbot-build/server-execution/Directory"
import { Transport as ResourceTransport } from "@openbot-build/server-execution/Transport"
import { Records } from "@openbot-build/server-kernel/Records"
import { Settings } from "@openbot-build/server-kernel/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
import { HostTools } from "@openbot-build/tools-contract/HostTools"
import * as ChatControlWorkflow from "./ChatControlWorkflow.ts"
import * as ExecutionFeatures from "./ExecutionFeatures.ts"
import * as HttpMounts from "./HttpMounts.ts"
import * as InputCommandsLayer from "./InputCommands.ts"
import * as LiveConnections from "./LiveConnections.ts"
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
