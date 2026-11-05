/** The work plugin: reminders, and the work tools of Bots. */
import { Digest, SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { BotRecords } from "../conversation-contract/bots/BotRecords.ts"
import { BotFeatures } from "../conversation-contract/chats/BotFeatures.ts"
import { InputCommands } from "../conversation-contract/chats/InputCommands.ts"
import { OpenWork } from "../conversation-contract/chats/OpenWork.ts"
import { TurnAccess } from "../conversation-contract/chats/TurnAccess.ts"
import { Reminders } from "../conversation-contract/work/Reminders.ts"
import { Runner } from "@openbot-build/server-execution/execution/Runner"
import { RunScope } from "@openbot-build/server-execution/execution/RunScope"
import { Store } from "@openbot-build/server-execution/execution/Store"
import { Workflows } from "@openbot-build/server-execution/execution/Workflows"
import { Records } from "@openbot-build/server-kernel/errors/Records"
import { Secrets } from "@openbot-build/server-kernel/secrets/Secrets"
import { Settings } from "@openbot-build/server-kernel/settings/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
import * as ReminderCommands from "./ReminderCommands.ts"
import * as RemindersLayer from "./Reminders.ts"
import * as ReminderWorkflow from "./ReminderWorkflow.ts"
import * as WorkFeature from "./WorkFeature.ts"

export const id = "work"

/** The keys that this plugin publishes. */
export const publishes = [Reminders, ReminderCommands.ReminderCommands] as const

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
