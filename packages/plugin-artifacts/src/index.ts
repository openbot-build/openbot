/** Fixed files, sources, citations, and the tools that make them. */
import { PgClient } from "@effect/sql-pg"
import { Authorization } from "@openbot-build/domain"
import { Layer } from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { AppCommands } from "@openbot-build/apps-contract/apps/AppCommands"
import { ArtifactFiles } from "@openbot-build/apps-contract/artifacts/ArtifactFiles"
import { BotFeatures } from "@openbot-build/conversation-contract/chats/BotFeatures"
import { Organization } from "@openbot-build/identity-contract/organization/Organization"
import { PublicNetwork } from "@openbot-build/protocol/Network"
import { Calls } from "@openbot-build/server-execution/execution/Calls"
import { ImportedRecords } from "@openbot-build/server-execution/imported/ImportedRecords"
import { Observation } from "@openbot-build/server-execution/execution/Observation"
import { Runner } from "@openbot-build/server-execution/execution/Runner"
import { RunScope } from "@openbot-build/server-execution/execution/RunScope"
import { Store } from "@openbot-build/server-execution/execution/Store"
import { Workflows } from "@openbot-build/server-execution/execution/Workflows"
import { Records } from "@openbot-build/server-kernel/errors/Records"
import { ComputerFiles } from "@openbot-build/tools-contract/computers/ComputerFiles"
import * as Feature from "@openbot-build/server-plugin/Feature"
import * as Artifacts from "./Artifacts.ts"
import * as Materials from "./Materials.ts"
import * as ArtifactFeature from "./ArtifactFeature.ts"
import * as HttpMounts from "./HttpMounts.ts"
import * as Workflow from "./Workflow.ts"

export default Feature.make("@openbot-build/plugin-artifacts")
	.stage({
		inject: [
			AppCommands,
			ArtifactFiles,
			Authorization.Auth,
			Calls,
			ComputerFiles,
			Digest.Digest,
			ImportedRecords,
			Observation,
			Organization,
			PgClient.PgClient,
			PublicNetwork,
			SecureRandom.SecureRandom,
			SqlClient.SqlClient,
			Store,
			Workflows,
		],
		services: Artifacts.layer.pipe(Layer.provideMerge(Materials.layer)),
		publishes: [Artifacts.Artifacts, Materials.Materials],
	})
	.start({
		inject: [...HttpMounts.inject, BotFeatures, Records, Runner, RunScope],
		layer: Feature.inOrder(
			ArtifactFeature.layer,
			Workflow.layer,
			HttpMounts.layer,
		),
	})
