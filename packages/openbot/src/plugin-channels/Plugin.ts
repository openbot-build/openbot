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
import { AuditLog } from "../identity-contract/audit/AuditLog.ts"
import { Organization } from "../identity-contract/organization/Organization.ts"
import { ModelRegistry } from "../models-contract/models/ModelRegistry.ts"
import { Calls } from "../server-execution/execution/Calls.ts"
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
