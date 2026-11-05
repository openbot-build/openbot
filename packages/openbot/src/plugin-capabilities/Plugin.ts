/** The capabilities plugin: Grants, Rules, requests, and the gates that check them. */
import { PgClient } from "@effect/sql-pg"
import { Authorization } from "@openbot-build/domain"
import { Layer } from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { AppApprovals } from "../apps-contract/apps/AppApprovals.ts"
import { BotRecords } from "../conversation-contract/bots/BotRecords.ts"
import { Bots } from "../conversation-contract/bots/Bots.ts"
import { Delegations } from "../conversation-contract/bots/Delegations.ts"
import { Gates } from "../conversation-contract/capabilities/Gate.ts"
import { Grants } from "../conversation-contract/capabilities/Grants.ts"
import { RequestCommands } from "../conversation-contract/capabilities/RequestCommands.ts"
import { Requests } from "../conversation-contract/capabilities/Requests.ts"
import { ReviewTools } from "../conversation-contract/capabilities/ReviewTools.ts"
import { Rules } from "../conversation-contract/capabilities/Rules.ts"
import { InputCommands } from "../conversation-contract/chats/InputCommands.ts"
import { TurnAccess } from "../conversation-contract/chats/TurnAccess.ts"
import { TurnContext } from "../conversation-contract/chats/TurnContext.ts"
import { AuditLog } from "@openbot-build/identity-contract/audit/AuditLog"
import { ModelRegistry } from "../models-contract/models/ModelRegistry.ts"
import { Billing } from "@openbot-build/server-billing/billing/Billing"
import { Calls } from "@openbot-build/server-execution/execution/Calls"
import { Observation } from "@openbot-build/server-execution/execution/Observation"
import { Runner } from "@openbot-build/server-execution/execution/Runner"
import { RunScope } from "@openbot-build/server-execution/execution/RunScope"
import { Store } from "@openbot-build/server-execution/execution/Store"
import { Workflows } from "@openbot-build/server-execution/execution/Workflows"
import { ImportedRecords } from "@openbot-build/server-execution/imported/ImportedRecords"
import { Records } from "@openbot-build/server-kernel/errors/Records"
import { Settings } from "@openbot-build/server-kernel/settings/Settings"
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

export const id = "capabilities"

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

/** The keys that this plugin publishes. */
export const publishes = [...records, ...requests] as const

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
			AppApprovals,
			AuditLog,
			Authorization.Auth,
			Bots,
			Delegations,
			ImportedRecords,
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
