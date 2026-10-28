import type { SecretStorageError } from "../secrets/Secrets.ts"
import {
	Authorization,
	Execution,
	Files,
	ServiceId,
	type Caller,
	type ServiceIdentity,
} from "@openbot-build/domain"
import { and, eq, isNull, lt, notExists, or } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import * as Check from "../authorization/Check.ts"
import * as Db from "../database/Database.ts"
import { executions, files, fileRefs } from "../database/Schema.ts"
import {
	Store,
	transactionFailures,
	storage,
	type Fence,
	type Key,
} from "../execution/Store.ts"
import { filesDefaults, filesOf } from "../settings/Documents.ts"
import { Settings } from "../settings/Settings.ts"

export const cleanupWorkflowName = "openbot.file-cleanup"
export const retentionWorkflowName = "openbot.file-retention"
export const serviceId = ServiceId.make("file-maintenance")
export const namespace = "file-maintenance"
export const identity: ServiceIdentity = {
	owner: { kind: "platform" },
	actor: { kind: "service", serviceId },
}
export const Reference = Schema.Struct({
	fileId: Schema.String,
	objectKey: Schema.String,
})
export interface Service {
	readonly remove: (
		caller: Caller,
		id: string,
	) => Effect.Effect<
		undefined,
		| Execution.Conflict
		| Files.FileNotFound
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly collect: Effect.Effect<
		number,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly cleanup: (
		key: Key,
	) => Effect.Effect<
		typeof Reference.Type,
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly objectKey: (
		key: Key,
	) => Effect.Effect<
		string,
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly complete: (
		fence: Fence,
	) => Effect.Effect<
		undefined,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Schema.SchemaError
		| SecretStorageError
		| Execution.StorageError
	>
	readonly start: Effect.Effect<
		Execution.Receipt,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly authorizeCleanup: (
		key: Key,
	) => Effect.Effect<
		void,
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly authorizeRetention: (
		key: Key,
	) => Effect.Effect<
		void,
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
}

export class FileTasks extends Context.Service<FileTasks, Service>()(
	"@openbot-build/openbot/files/FileTasks",
) {}

const make = Effect.gen(function* () {
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const store = yield* Store
	const checks = yield* Check.make
	const settings = yield* Settings
	const enqueue = (id: string) =>
		Effect.gen(function* () {
			const row = (yield* db
				.select()
				.from(files)
				.where(eq(files.id, id))
				.for("update"))[0]
			if (row === undefined) return yield* Files.FileNotFound.make({ id })
			if (row.cleanupExecutionId !== null) {
				const previous = (yield* db
					.select({ namespace: executions.namespace })
					.from(executions)
					.where(eq(executions.id, row.cleanupExecutionId)))[0]
				if (previous === undefined)
					return yield* Execution.NotFound.make({
						id: Execution.Id.make(row.cleanupExecutionId),
					})
				const key = {
					namespace: previous.namespace,
					id: Execution.Id.make(row.cleanupExecutionId),
				}
				const saved = yield* store.get(key)
				if (saved.resource.kind !== "File" || saved.resource.id !== id)
					return yield* Execution.Forbidden.make({})
				if (!Execution.isTerminal(saved.status)) return key
			}
			const receipt = yield* store.submit(
				namespace,
				Execution.CommandKey.make(
					row.cleanupExecutionId === null
						? `delete:${id}`
						: `delete:${id}:${row.cleanupExecutionId}`,
				),
				{
					workflow: cleanupWorkflowName,
					identity,
					resource: { kind: "File", id },
					input: { fileId: id, objectKey: row.objectKey },
				},
			)
			yield* db
				.update(files)
				.set({
					status: "deleting",
					cleanupExecutionId: receipt.executionId,
					updatedAt: yield* Clock.currentTimeMillis,
				})
				.where(eq(files.id, id))
			return { namespace, id: receipt.executionId }
		})
	const remove = (caller: Caller, id: string) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					yield* checks
						.check(caller, {
							action: "write",
							resource: Authorization.File.make({
								organizationId: caller.organizationId,
								ownerUserId: caller.userId,
								id,
							}),
						})
						.pipe(
							Effect.catchTags({
								Forbidden: () => Effect.fail(Execution.Forbidden.make({})),
								Pending: () => Effect.fail(Execution.Forbidden.make({})),
								PolicyUnavailable: (cause) =>
									Effect.fail(Execution.StorageError.make({ cause })),
							}),
						)
					const row = (yield* db
						.select()
						.from(files)
						.where(
							and(
								eq(files.id, id),
								eq(files.organizationId, caller.organizationId),
								eq(files.userId, caller.userId),
							),
						)
						.for("update"))[0]
					if (row === undefined) return yield* Files.FileNotFound.make({ id })
					yield* enqueue(id)
				}),
			)
			.pipe(transactionFailures)
	// This query finds files whose retention time has ended. The engine owns all deletion work.
	const collect = sql
		.withTransaction(
			Effect.gen(function* () {
				const document = Option.match(yield* settings.platform, {
					onNone: () => filesDefaults,
					onSome: (snapshot) => filesOf(snapshot.document),
				})
				const now = yield* Clock.currentTimeMillis
				const expired = yield* db
					.select({ id: files.id })
					.from(files)
					.where(
						and(
							isNull(files.cleanupExecutionId),
							or(
								and(
									eq(files.status, "pending"),
									lt(files.updatedAt, now - Files.pendingLifetimeMs),
								),
								and(
									eq(files.status, "ready"),
									lt(files.updatedAt, now - document.unusedMs),
									notExists(
										db
											.select({ file: fileRefs.file })
											.from(fileRefs)
											.where(eq(fileRefs.file, files.id)),
									),
								),
							),
						),
					)
					.orderBy(files.updatedAt)
					.limit(100)
					.for("update", { skipLocked: true })
				yield* Effect.forEach(expired, (row) => enqueue(row.id), {
					discard: true,
				})
				return expired.length
			}),
		)
		.pipe(storage)
	const load = (key: Key, workflow: string) =>
		Effect.gen(function* () {
			const saved = yield* store.loadService(key, serviceId)
			if (
				key.namespace !== namespace ||
				saved.workflow !== workflow ||
				saved.identity.owner.kind !== "platform"
			)
				return yield* Execution.Forbidden.make({})
			return saved
		})
	const cleanup = (key: Key) =>
		Effect.gen(function* () {
			const saved = yield* load(key, cleanupWorkflowName)
			const input = yield* Schema.decodeUnknownEffect(Reference)(
				saved.input,
			).pipe(Effect.orDie)
			if (
				saved.record.resource.kind !== "File" ||
				saved.record.resource.id !== input.fileId
			)
				return yield* Execution.Forbidden.make({})
			return input
		})
	const objectKey = (key: Key) =>
		Effect.gen(function* () {
			const ref = yield* cleanup(key)
			const row = (yield* db
				.select()
				.from(files)
				.where(eq(files.id, ref.fileId)))[0]
			if (row === undefined) return ref.objectKey
			if (
				row.status !== "deleting" ||
				row.cleanupExecutionId !== key.id ||
				row.objectKey !== ref.objectKey
			)
				return yield* Execution.Forbidden.make({})
			return row.objectKey
		}).pipe(transactionFailures)
	const complete = (fence: Fence) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const ref = yield* cleanup(fence)
					const row = (yield* db
						.select()
						.from(files)
						.where(eq(files.id, ref.fileId))
						.for("update"))[0]
					if (row !== undefined && row.cleanupExecutionId !== fence.id)
						return yield* Execution.Forbidden.make({})
					yield* store.commit(
						fence,
						{
							status: "completed",
							events: [
								{ _tag: "Result", resource: { kind: "File", id: ref.fileId } },
							],
						},
						db.delete(files).where(eq(files.id, ref.fileId)),
					)
				}),
			)
			.pipe(transactionFailures)
	const start = store.submit(
		namespace,
		Execution.CommandKey.make("retention"),
		{
			workflow: retentionWorkflowName,
			identity,
			resource: { kind: "FileRetention", id: "platform" },
			input: {},
		},
	)
	return FileTasks.of({
		remove,
		collect,
		cleanup,
		objectKey,
		complete,
		start,
		authorizeCleanup: (key: Key) => cleanup(key).pipe(Effect.asVoid),
		authorizeRetention: (key: Key) =>
			load(key, retentionWorkflowName).pipe(Effect.asVoid),
	})
})

export const layer = Layer.effect(FileTasks, make)
