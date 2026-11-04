/** The work plugin: reminders, and the work tools of Bots. */
import { Digest, SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { BotRecords } from "../conversation-contract/bots/BotRecords.ts"
import { BotFeatures } from "../conversation-contract/chats/BotFeatures.ts"
import { InputCommands } from "../conversation-contract/chats/InputCommands.ts"
import { OpenWork } from "../conversation-contract/chats/OpenWork.ts"
import { TurnAccess } from "../conversation-contract/chats/TurnAccess.ts"
import { Reminders } from "../conversation-contract/work/Reminders.ts"
import { Runner } from "../server-execution/execution/Runner.ts"
import { RunScope } from "../server-execution/execution/RunScope.ts"
import { Store } from "../server-execution/execution/Store.ts"
import { Workflows } from "../server-execution/execution/Workflows.ts"
import { Records } from "../server-kernel/errors/Records.ts"
import { Secrets } from "../server-kernel/secrets/Secrets.ts"
import { Settings } from "../server-kernel/settings/Settings.ts"
import * as Feature from "../server-plugin/Feature.ts"
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
