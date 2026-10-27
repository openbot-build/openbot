import type { Live, Model, Provider } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import { eq } from "drizzle-orm"
import { Array as Arr, Effect } from "effect"
import * as Db from "../../src/database/Database.ts"
import { fileRefs, files } from "../../src/database/Schema.ts"
import { Store } from "../../src/execution/Store.ts"
import { FileTasks } from "../../src/files/FileTasks.ts"
import * as LiveBackends from "../../src/models/LiveBackends.ts"

/** Gives the host a controlled Live provider at its outside boundary. */
export const liveBackend = (
	make: (input: {
		readonly providerId: Provider.Id
		readonly modelId: Model.Id
	}) => Effect.Effect<Live.LiveModel, Live.LiveError>,
) => LiveBackends.layer([{ kind: "openai", make }])

/** Counts saved links so a file test can check that a Chat keeps its bytes. */
export const fileReferences = (id: string) =>
	Effect.flatMap(Db.make, (db) =>
		db
			.select({ file: fileRefs.file })
			.from(fileRefs)
			.where(eq(fileRefs.file, id)),
	)

/** Makes saved files old without waiting for the full retention time. */
export const ageFiles = Effect.flatMap(Db.make, (db) =>
	db.update(files).set({ updatedAt: 0 }),
)

/** Runs the normal file retention pass after the test changes file age. */
export const collectFiles = Effect.flatMap(FileTasks, (tasks) => tasks.collect)

/** Reads only the saved file fields needed to check removal and recovery. */
export const savedFiles = (id?: string) =>
	Effect.flatMap(Db.make, (db) =>
		db
			.select({ id: files.id, cleanupExecutionId: files.cleanupExecutionId })
			.from(files)
			.where(id === undefined ? undefined : eq(files.id, id)),
	)

/** Reads the calls made by one file removal task, including a lost reply. */
export const fileDeleteCalls = (id: string) =>
	Effect.flatMap(Store, (store) =>
		store.calls({ namespace: "file-maintenance", id: Execution.Id.make(id) }),
	).pipe(
		Effect.map(
			Arr.map((call) => ({ status: call.status, result: call.result })),
		),
	)

/** Reads the saved state after the file removal worker starts again. */
export const fileDeleteStatus = (id: string) =>
	Effect.flatMap(Store, (store) =>
		store.get({ namespace: "file-maintenance", id: Execution.Id.make(id) }),
	).pipe(Effect.map((record) => record.status))
