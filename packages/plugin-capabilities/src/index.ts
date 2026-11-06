/** The capabilities plugin: Grants, Rules, requests, and the gates that check them. */
import { PgClient } from "@effect/sql-pg"
import { Authorization } from "@openbot-build/domain"
import { Layer } from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { BotRecords } from "@openbot-build/conversation-contract/bots/BotRecords"
import { Bots } from "@openbot-build/conversation-contract/bots/Bots"
import { Delegations } from "@openbot-build/conversation-contract/bots/Delegations"
import { Gates } from "@openbot-build/conversation-contract/capabilities/Gate"
import { Grants } from "@openbot-build/conversation-contract/capabilities/Grants"
import { RequestCommands } from "@openbot-build/conversation-contract/capabilities/RequestCommands"
import { Requests } from "@openbot-build/conversation-contract/capabilities/Requests"
import { ReviewTools } from "@openbot-build/conversation-contract/capabilities/ReviewTools"
import { Rules } from "@openbot-build/conversation-contract/capabilities/Rules"
import { InputCommands } from "@openbot-build/conversation-contract/chats/InputCommands"
import { TurnAccess } from "@openbot-build/conversation-contract/chats/TurnAccess"
import { TurnContext } from "@openbot-build/conversation-contract/chats/TurnContext"
import { AuditLog } from "@openbot-build/identity-contract/audit/AuditLog"
import { ModelRegistry } from "@openbot-build/models-contract/ModelRegistry"
import { Billing } from "@openbot-build/server-billing/Billing"
import { Calls } from "@openbot-build/server-execution/Calls"
import { Observation } from "@openbot-build/server-execution/Observation"
import { Runner } from "@openbot-build/server-execution/Runner"
import { RunScope } from "@openbot-build/server-execution/RunScope"
import { Store } from "@openbot-build/server-execution/Store"
import { Workflows } from "@openbot-build/server-execution/Workflows"
import { Records } from "@openbot-build/server-kernel/Records"
import { Settings } from "@openbot-build/server-kernel/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
import * as GatesLayer from "./Gates.ts"
import * as GrantsLayer from "./Grants.ts"
import * as HttpMounts from "./HttpMounts.ts"
import * as RequestCommandsLayer from "./RequestCommands.ts"
import * as RequestNotices from "./RequestNotices.ts"
import * as RequestNoticeWorkflow from "./RequestNoticeWorkflow.ts"
import * as RequestReviews from "./RequestReviews.ts"
import * as RequestsLayer from "./Requests.ts"
import * as RequestWorkflow from "./RequestWorkflow.ts"
import * as ReviewToolsLayer from "./ReviewTools.ts"
import * as RulesLayer from "./Rules.ts"

/** Grants, Rules and requests. */
const records = [Grants, Requests, Rules] as const

/** The gates, the reviews and the commands of requests. */
const requests = [
	Gates,
	RequestCommands,
	RequestNotices.RequestNotices,
	RequestReviews.RequestReviews,
	ReviewTools,
] as const

export default Feature.make("@openbot-build/plugin-capabilities")
	.stage({
		inject: [BotRecords, Records, SecureRandom.SecureRandom, Settings],
		services: RequestsLayer.layer.pipe(
			Layer.provideMerge(Layer.merge(GrantsLayer.layer, RulesLayer.layer)),
		),
		publishes: records,
	})
	.stage({
		name: "requests",
		inject: [
			AuditLog,
			Authorization.Auth,
			Bots,
			Delegations,
			InputCommands,
			ModelRegistry,
			TurnAccess,
			TurnContext,
			Billing,
			Calls,
			Digest.Digest,
			Observation,
			PgClient.PgClient,
			SqlClient.SqlClient,
			Store,
		],
		services: Layer.mergeAll(
			GatesLayer.layer,
			ReviewToolsLayer.layer,
			RequestReviews.layer,
			RequestNotices.layer,
		).pipe(Layer.provideMerge(RequestCommandsLayer.layer)),
		publishes: requests,
	})
	.start({
		inject: [...HttpMounts.inject, RunScope, Runner, Workflows],
		layer: Feature.inOrder(
			RequestWorkflow.layer,
			RequestNoticeWorkflow.layer,
			HttpMounts.layer,
		),
	})
