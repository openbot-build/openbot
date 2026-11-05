/** The channels plugin: Channels, their messages, and the Channel tools of Bots. */
import { PgClient } from "@effect/sql-pg"
import { Authorization } from "@openbot-build/domain"
import { Layer } from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { AppNetwork } from "../apps-contract/apps/AppNetwork.ts"
import { Bots } from "../conversation-contract/bots/Bots.ts"
import { RequestCommands } from "../conversation-contract/capabilities/RequestCommands.ts"
import { Requests } from "../conversation-contract/capabilities/Requests.ts"
import { Channels } from "../conversation-contract/channels/Channels.ts"
import { BotFeatures } from "../conversation-contract/chats/BotFeatures.ts"
import { InputCommands } from "../conversation-contract/chats/InputCommands.ts"
import { AuditLog } from "@openbot-build/identity-contract/audit/AuditLog"
import { Organization } from "@openbot-build/identity-contract/organization/Organization"
import { ModelRegistry } from "../models-contract/models/ModelRegistry.ts"
import { Calls } from "@openbot-build/server-execution/execution/Calls"
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
import * as ChannelConfig from "./ChannelConfig.ts"
import * as ChannelConfigWorkflow from "./ChannelConfigWorkflow.ts"
import * as ChannelFeature from "./ChannelFeature.ts"
import * as ChannelInbox from "./ChannelInbox.ts"
import * as ChannelQueue from "./ChannelQueue.ts"
import * as ChannelRegistry from "./ChannelRegistry.ts"
import * as ChannelRemoval from "./ChannelRemoval.ts"
import * as ChannelRemovalWorkflow from "./ChannelRemovalWorkflow.ts"
import * as ChannelWatch from "./ChannelWatch.ts"
import * as ChannelWorkflows from "./ChannelWorkflows.ts"
import * as HttpMounts from "./HttpMounts.ts"
import * as Layers from "./Layers.ts"

export const id = "channels"

/** The keys that this plugin publishes. */
export const publishes = [
	ChannelConfig.ChannelConfig,
	ChannelInbox.ChannelInbox,
	ChannelQueue.ChannelQueue,
	ChannelRegistry.ChannelRegistry,
	ChannelRemoval.ChannelRemoval,
	ChannelWatch.ChannelWatch,
	Channels,
] as const

export default Feature.make("@openbot-build/plugin-channels")
	.stage({
		inject: [
			AuditLog,
			Authorization.Auth,
			Bots,
			AppNetwork,
			Digest.Digest,
			HttpClient.HttpClient,
			Observation,
			PgClient.PgClient,
			Secrets,
			SecureRandom.SecureRandom,
			Settings,
			SqlClient.SqlClient,
			Store,
		],
		services: Layer.merge(ChannelConfig.layer, ChannelRemoval.layer).pipe(
			Layer.provideMerge(Layers.layerChannels),
		),
		publishes,
	})
	.start({
		inject: [
			...HttpMounts.inject,
			BotFeatures,
			ImportedRecords,
			InputCommands,
			ModelRegistry,
			Organization,
			RequestCommands,
			Requests,
			Calls,
			Records,
			RunScope,
			Runner,
			Workflows,
		],
		layer: Feature.inOrder(
			ChannelFeature.layer,
			ChannelConfigWorkflow.layer,
			ChannelRemovalWorkflow.layer,
			ChannelWorkflows.layer,
			HttpMounts.layer,
		),
	})
