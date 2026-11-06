/** The work plugin: reminders, and the work tools of Bots. */
import { Digest, SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { BotRecords } from "@openbot-build/conversation-contract/bots/BotRecords"
import { BotFeatures } from "@openbot-build/conversation-contract/chats/BotFeatures"
import { InputCommands } from "@openbot-build/conversation-contract/chats/InputCommands"
import { OpenWork } from "@openbot-build/conversation-contract/chats/OpenWork"
import { TurnAccess } from "@openbot-build/conversation-contract/chats/TurnAccess"
import { Reminders } from "@openbot-build/conversation-contract/work/Reminders"
import { Runner } from "@openbot-build/server-execution/Runner"
import { RunScope } from "@openbot-build/server-execution/RunScope"
import { Store } from "@openbot-build/server-execution/Store"
import { Workflows } from "@openbot-build/server-execution/Workflows"
import { Records } from "@openbot-build/server-kernel/Records"
import { Secrets } from "@openbot-build/server-kernel/Secrets"
import { Settings } from "@openbot-build/server-kernel/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
import * as ReminderCommands from "./ReminderCommands.ts"
import * as RemindersLayer from "./Reminders.ts"
import * as ReminderWorkflow from "./ReminderWorkflow.ts"
import * as WorkFeature from "./WorkFeature.ts"

export default Feature.make("@openbot-build/plugin-work")
	.stage({
		inject: [BotRecords, Digest.Digest, Secrets],
		services: RemindersLayer.layer,
		publishes: [Reminders],
	})
	.stage({
		name: "commands",
		inject: [InputCommands, TurnAccess, SqlClient.SqlClient, Store],
		services: ReminderCommands.layer,
		publishes: [ReminderCommands.ReminderCommands],
	})
	.start({
		inject: [
			BotFeatures,
			OpenWork,
			Records,
			RunScope,
			Runner,
			SecureRandom.SecureRandom,
			Settings,
			Workflows,
		],
		layer: Feature.inOrder(WorkFeature.layer, ReminderWorkflow.layer),
	})
