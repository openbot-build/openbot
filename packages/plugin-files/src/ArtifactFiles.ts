import { Digest } from "effect/crypto"
import {
	ArtifactFiles,
	type Reservation,
} from "@openbot-build/apps-contract/artifacts/ArtifactFiles"
import { Files as FileData } from "@openbot-build/domain"
import { and, eq, inArray, sql } from "drizzle-orm"
import { Clock, Effect, Layer, Option, Stream } from "effect"
import { HttpClient } from "effect/http"
import * as Db from "@openbot-build/server-database/Database"
import { artifactFiles, files } from "@openbot-build/server-database/Schema"
import * as Failures from "@openbot-build/server-kernel/errors/Failures"
import { accepts } from "./Files.ts"
import * as Objects from "./Objects.ts"
import * as S3 from "./S3.ts"
import { quotaOf } from "@openbot-build/server-kernel/settings/Documents"
import { transactionFailures } from "@openbot-build/server-execution/execution/Store"

/** Storage work uses the same limits and quota as member uploads. */
const make = Effect.gen(function* () {
	const db = yield* Db.make
	const objects = yield* Objects.make
	const http = yield* HttpClient.HttpClient
	const crypto = yield* Digest.Digest
	const stored = Failures.replace("Could not read the artifact file", () =>
		FileData.FilesUnavailable.make({}),
	)
	const outside = <A>(work: Effect.Effect<A, S3.StorageError, Digest.Digest>) =>
		work.pipe(Effect.provideService(Digest.Digest, crypto), stored)
	const location = Effect.gen(function* () {
		const config = yield* objects.config.pipe(stored)
		return { config, ...(yield* objects.target(config).pipe(stored)) }
	})
	const get = (id: string) =>
		db
			.select()
			.from(files)
			.where(eq(files.id, id))
			.pipe(
				stored,
				Effect.map((rows) => Option.fromUndefinedOr(rows[0])),
			)
	return {
		get,
		reserve: (input: Reservation) =>
			Effect.gen(function* () {
				const { config } = yield* location
				if (
					input.bytes > config.maxBytes ||
					!accepts(config.mediaTypes, input.mediaType)
				)
					return yield* FileData.FileInvalid.make({
						message: "The file type or size is not allowed by the platform.",
					})
				const { organizationId, userId } = input.identity.owner
				yield* db
					.transaction((tx) =>
						Effect.gen(function* () {
							yield* tx.execute(
								sql`SELECT pg_advisory_xact_lock(hashtextextended(${"openbot-files:" + organizationId + ":" + userId}, 0))`,
							)
							const current = (yield* tx
								.select()
								.from(files)
								.where(eq(files.id, input.id)))[0]
							if (current !== undefined) {
								if (current.status !== "pending" && current.status !== "ready")
									return yield* FileData.FileNotFound.make({ id: input.id })
								return
							}
							if (
								(yield* tx
									.select({ file: artifactFiles.file })
									.from(artifactFiles)
									.where(eq(artifactFiles.file, input.id))).length > 0
							)
								return yield* FileData.FileNotFound.make({ id: input.id })
							const rows = yield* tx
								.select({
									bytes: sql<string>`coalesce(sum(${files.bytes}), 0)`,
								})
								.from(files)
								.where(
									and(
										eq(files.organizationId, organizationId),
										eq(files.userId, userId),
										inArray(files.status, ["pending", "ready"]),
									),
								)
							const used = Number(rows[0]?.bytes ?? 0)
							const quota = quotaOf(config)
							if (quota !== null && used + input.bytes > quota)
								return yield* FileData.FileQuotaExceeded.make({
									message: "The file does not fit in the owner's file quota.",
									quotaBytes: quota,
									usedBytes: used,
								})
							const now = yield* Clock.currentTimeMillis
							yield* tx.insert(files).values({
								id: input.id,
								organizationId,
								userId,
								filename: input.filename,
								mediaType: input.mediaType,
								bytes: input.bytes,
								status: "pending",
								objectKey: "files/" + input.id,
								cleanupExecutionId: null,
								createdAt: now,
								updatedAt: now,
							})
							yield* tx.insert(artifactFiles).values({
								file: input.id,
								namespace: input.namespace,
								chat: input.chat,
								executionId: input.executionId,
							})
						}),
					)
					.pipe(transactionFailures)
			}),
		put: (id: string, bytes: Uint8Array, mediaType: string) =>
			Effect.gen(function* () {
				const { target } = yield* location
				const now = yield* Clock.currentTimeMillis
				yield* outside(
					S3.put(
						http,
						target,
						"files/" + id,
						{ bytes, contentType: mediaType },
						now,
					),
				)
			}),
		read: (id: string) =>
			Effect.gen(function* () {
				const row = yield* get(id)
				if (
					Option.isNone(row) ||
					(row.value.status !== "pending" && row.value.status !== "ready")
				)
					return Option.none<Uint8Array>()
				const { target } = yield* location
				return yield* outside(
					S3.get(
						http,
						target,
						row.value.objectKey,
						yield* Clock.currentTimeMillis,
					),
				)
			}),
		content: (id: string) =>
			Effect.gen(function* () {
				const row = yield* get(id)
				if (Option.isNone(row) || row.value.status !== "ready")
					return yield* FileData.FileNotFound.make({ id })
				const { target } = yield* location
				const found = yield* outside(
					S3.getStream(
						http,
						target,
						row.value.objectKey,
						yield* Clock.currentTimeMillis,
					),
				)
				if (Option.isNone(found))
					return yield* FileData.FileNotFound.make({ id })
				return Stream.catch(found.value, (error) =>
					Stream.fromEffect(outside(Effect.fail(error))),
				)
			}),
	}
})

export const layer = Layer.effect(ArtifactFiles, make)
