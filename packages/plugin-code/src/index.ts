/** The code plugin: code runs of Bots in a sandbox. */
import { PgClient } from "@effect/sql-pg"
import { Authorization } from "@openbot-build/domain"
import { FileSystem, Layer } from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { AppCommands } from "@openbot-build/apps-contract/apps/AppCommands"
import { CodeCommands } from "@openbot-build/apps-contract/code/CodeCommands"
import { Vaults } from "@openbot-build/apps-contract/vaults/Vaults"
import { TurnAccess } from "@openbot-build/conversation-contract/chats/TurnAccess"
import { Calls } from "@openbot-build/server-execution/Calls"
import { Observation } from "@openbot-build/server-execution/Observation"
import { Runner } from "@openbot-build/server-execution/Runner"
import { RunScope } from "@openbot-build/server-execution/RunScope"
import { Store } from "@openbot-build/server-execution/Store"
import { Workflows } from "@openbot-build/server-execution/Workflows"
import { Records } from "@openbot-build/server-kernel/Records"
import { Settings } from "@openbot-build/server-kernel/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
import * as CodeCommandsLayer from "./CodeCommands.ts"
import * as CodeProgram from "./CodeProgram.ts"
import * as CodeWorkflow from "./CodeWorkflow.ts"
import * as HttpMounts from "./HttpMounts.ts"
import * as Sandbox from "./Sandbox.ts"

/** The keys that this plugin publishes. */
const publishes = [
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
			PgClient.PgClient,
			RunScope,
			Runner,
			Workflows,
		],
		layer: Feature.inOrder(CodeWorkflow.layer, HttpMounts.layer),
	})
