/** The files plugin: stored files, their tasks and their workflows. */
import { PgClient } from "@effect/sql-pg"
import { Authorization } from "@openbot-build/domain"
import { Digest, SecureRandom } from "effect/crypto"
import { Layer } from "effect"
import { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { Files } from "../apps-contract/files/Files.ts"
import { Calls } from "../server-execution/execution/Calls.ts"
import { Runner } from "../server-execution/execution/Runner.ts"
import { RunScope } from "../server-execution/execution/RunScope.ts"
import { Store } from "../server-execution/execution/Store.ts"
import { Workflows } from "../server-execution/execution/Workflows.ts"
import { Records } from "../server-kernel/errors/Records.ts"
import { Secrets } from "../server-kernel/secrets/Secrets.ts"
import { Settings } from "../server-kernel/settings/Settings.ts"
import * as Feature from "../server-plugin/Feature.ts"
import * as FilesLayer from "./Files.ts"
import * as FileTasks from "./FileTasks.ts"
import * as FileWorkflows from "./FileWorkflows.ts"
import * as HttpMounts from "./HttpMounts.ts"

export const id = "files"

/** The keys that this plugin publishes. */
export const publishes = [Files, FileTasks.FileTasks] as const

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
		services: FilesLayer.layer.pipe(Layer.provideMerge(FileTasks.layer)),
		publishes,
	})
	.start({
		inject: [...HttpMounts.inject, Calls, Records, RunScope, Runner, Workflows],
		layer: Feature.inOrder(FileWorkflows.layer, HttpMounts.layer),
	})
