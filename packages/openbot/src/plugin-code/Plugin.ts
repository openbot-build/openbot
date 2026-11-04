/** The code plugin: code runs of Bots in a sandbox. */
import { PgClient } from "@effect/sql-pg"
import { Authorization } from "@openbot-build/domain"
import { FileSystem, Layer } from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { AppCommands } from "../apps-contract/apps/AppCommands.ts"
import { CodeCommands } from "../apps-contract/code/CodeCommands.ts"
import { Vaults } from "../apps-contract/vaults/Vaults.ts"
import { TurnAccess } from "../conversation-contract/chats/TurnAccess.ts"
import { Calls } from "../server-execution/execution/Calls.ts"
import { Observation } from "../server-execution/execution/Observation.ts"
import { Runner } from "../server-execution/execution/Runner.ts"
import { RunScope } from "../server-execution/execution/RunScope.ts"
import { Store } from "../server-execution/execution/Store.ts"
import { Workflows } from "../server-execution/execution/Workflows.ts"
import { ImportedRecords } from "../server-execution/imported/ImportedRecords.ts"
import { Records } from "../server-kernel/errors/Records.ts"
import { Settings } from "../server-kernel/settings/Settings.ts"
import * as Feature from "../server-plugin/Feature.ts"
import * as CodeCommandsLayer from "./CodeCommands.ts"
import * as CodeProgram from "./CodeProgram.ts"
import * as CodeWorkflow from "./CodeWorkflow.ts"
import * as HttpMounts from "./HttpMounts.ts"
import * as Sandbox from "./Sandbox.ts"

export const id = "code"

/** The keys that this plugin publishes. */
export const publishes = [
	CodeCommands,
	CodeProgram.CodeProgram,
	Sandbox.Sandbox,
] as const

export default Feature.make("@openbot-build/plugin-code")
	.stage({
		inject: [
			AppCommands,
			TurnAccess,
			Vaults,
			Calls,
			Digest.Digest,
			FileSystem.FileSystem,
			Observation,
			Records,
			SecureRandom.SecureRandom,
			Settings,
			SqlClient.SqlClient,
			Store,
		],
		services: CodeProgram.layer.pipe(
			Layer.provideMerge(CodeCommandsLayer.layer),
			Layer.provideMerge(Sandbox.layer),
		),
		publishes,
	})
	.start({
		inject: [
			...HttpMounts.inject,
			Authorization.Auth,
			ImportedRecords,
			PgClient.PgClient,
			RunScope,
			Runner,
			Workflows,
		],
		layer: Feature.inOrder(CodeWorkflow.layer, HttpMounts.layer),
	})
