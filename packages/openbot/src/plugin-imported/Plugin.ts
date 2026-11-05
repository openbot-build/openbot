/** The imported plugin: executions that started in another program. */
import { Authorization } from "@openbot-build/domain"
import { SqlClient } from "effect/sql"
import { Bots } from "../conversation-contract/bots/Bots.ts"
import { Store } from "@openbot-build/server-execution/execution/Store"
import { Workflows } from "@openbot-build/server-execution/execution/Workflows"
import { ImportedRecords } from "@openbot-build/server-execution/imported/ImportedRecords"
import * as Feature from "@openbot-build/server-plugin/Feature"
import * as ImportedWorkflow from "./ImportedWorkflow.ts"

export const id = "imported"

/** The keys that this plugin publishes. */
export const publishes = [ImportedRecords] as const

export default Feature.make("@openbot-build/plugin-imported")
	.stage({
		inject: [Authorization.Auth, Bots, SqlClient.SqlClient, Store],
		services: ImportedWorkflow.layerRecords,
		publishes,
	})
	.start({
		inject: [Workflows],
		layer: ImportedWorkflow.layer,
	})
