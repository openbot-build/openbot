/** The files plugin: stored files, their tasks and their workflows. */
import { PgClient } from "@effect/sql-pg"
import { Authorization } from "@openbot-build/domain"
import { Digest, SecureRandom } from "effect/crypto"
import { Layer } from "effect"
import { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { Files } from "@openbot-build/apps-contract/files/Files"
import { Calls } from "@openbot-build/server-execution/execution/Calls"
import { Runner } from "@openbot-build/server-execution/execution/Runner"
import { RunScope } from "@openbot-build/server-execution/execution/RunScope"
import { Store } from "@openbot-build/server-execution/execution/Store"
import { Workflows } from "@openbot-build/server-execution/execution/Workflows"
import { Records } from "@openbot-build/server-kernel/errors/Records"
import { Secrets } from "@openbot-build/server-kernel/secrets/Secrets"
import { Settings } from "@openbot-build/server-kernel/settings/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
import { ArtifactFiles } from "@openbot-build/apps-contract/artifacts/ArtifactFiles"
import * as ArtifactFilesLayer from "./ArtifactFiles.ts"
import * as FilesLayer from "./Files.ts"
import * as FileTasks from "./FileTasks.ts"
import * as FileWorkflows from "./FileWorkflows.ts"
import * as HttpMounts from "./HttpMounts.ts"

/** The keys that this plugin publishes. */
const publishes = [Files, FileTasks.FileTasks, ArtifactFiles] as const

export default Feature.make("@openbot-build/plugin-files")
	.stage({
		inject: [
			Authorization.Auth,
			Digest.Digest,
			HttpClient.HttpClient,
			PgClient.PgClient,
			Secrets,
			SecureRandom.SecureRandom,
			Settings,
			SqlClient.SqlClient,
			Store,
		],
		services: Layer.merge(FilesLayer.layer, ArtifactFilesLayer.layer).pipe(
			Layer.provideMerge(FileTasks.layer),
		),
		publishes,
	})
	.start({
		inject: [...HttpMounts.inject, Calls, Records, RunScope, Runner, Workflows],
		layer: Feature.inOrder(FileWorkflows.layer, HttpMounts.layer),
	})
