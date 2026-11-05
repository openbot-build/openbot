/** The channels plugin: Channels, their messages, and the Channel tools of Bots. */
import { PgClient } from "@effect/sql-pg"
import { Authorization } from "@openbot-build/domain"
import { Layer } from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { AppNetwork } from "@openbot-build/apps-contract/apps/AppNetwork"
import { Bots } from "@openbot-build/conversation-contract/bots/Bots"
import { RequestCommands } from "@openbot-build/conversation-contract/capabilities/RequestCommands"
import { Requests } from "@openbot-build/conversation-contract/capabilities/Requests"
import { Channels } from "@openbot-build/conversation-contract/channels/Channels"
import { BotFeatures } from "@openbot-build/conversation-contract/chats/BotFeatures"
import { InputCommands } from "@openbot-build/conversation-contract/chats/InputCommands"
import { AuditLog } from "@openbot-build/identity-contract/audit/AuditLog"
import { Organization } from "@openbot-build/identity-contract/organization/Organization"
import { ModelRegistry } from "@openbot-build/models-contract/models/ModelRegistry"
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

/** The keys that this plugin publishes. */
const publishes = [
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
