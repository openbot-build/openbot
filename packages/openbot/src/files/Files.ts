import { type Caller, FilesApi, type MessageInput } from "@openbot-build/api"
import { and, desc, eq, inArray, lt, notExists, sql } from "drizzle-orm"
import {
	Cache,
	Clock,
	Context,
	Crypto,
	Duration,
	Effect,
	Exit,
	Layer,
	Option,
	Predicate,
	Ref,
	Stream,
} from "effect"
import { Prompt } from "effect/ai"
import { Hex } from "effect/encoding"
import { HttpClient, Multipart } from "effect/http"
import * as Db from "../database/Database.ts"
import { fileRefs, files } from "../database/Schema.ts"
import { Secrets } from "../secrets/Secrets.ts"
import {
	filesDefaults,
	filesOf,
	type FilesDocument,
	quotaOf,
} from "../settings/Documents.ts"
import { bindings } from "../settings/Platform.ts"
import { Settings } from "../settings/Settings.ts"
import { fileUrl } from "./Refs.ts"
import * as S3 from "./S3.ts"

/** A signed upload address works this long. */
export const uploadLifetimeSeconds = 15 * 60
/** A pending file that nobody completed is garbage after this time. */
export const pendingLifetimeMs = 60 * 60 * 1000
/** How many files one step of the garbage collector deletes. */
const deleteBatch = 100

/** The bytes of a file for a model call. */
export interface Content {
	readonly mediaType: string
	readonly fileName: string
	readonly bytes: Uint8Array
}

type Failure =
	| FilesApi.FileNotFound
	| FilesApi.FileInvalid
	| FilesApi.FileQuotaExceeded
	| FilesApi.FilesDisabled
	| FilesApi.FilesUnavailable

/**
 * The files of the members. The bytes live in the object storage of the
 * platform settings. Rows in Postgres say who owns each file and which Chats use it.
 */
export class Files extends Context.Service<
	Files,
	{
		/** Takes the field `file` of a multipart form, and stores it at once. */
		readonly upload: (
			caller: Caller,
			parts: Stream.Stream<Multipart.Part, Multipart.MultipartError>,
		) => Effect.Effect<FilesApi.FileObject, Failure>
		/** Makes a pending file and a signed address where the client puts its bytes. */
		readonly createUpload: (
			caller: Caller,
			input: FilesApi.CreateUploadRequest,
		) => Effect.Effect<FilesApi.DirectUpload, Failure>
		readonly complete: (
			caller: Caller,
			id: string,
		) => Effect.Effect<FilesApi.FileObject, Failure>
		readonly list: (
			caller: Caller,
			query: { readonly limit?: number; readonly after?: string },
		) => Effect.Effect<FilesApi.FilePage, Failure>
		readonly get: (
			caller: Caller,
			id: string,
		) => Effect.Effect<FilesApi.FileObject, Failure>
		readonly content: (
			caller: Caller,
			id: string,
		) => Effect.Effect<Uint8Array, Failure>
		/** Deletes a file now. The garbage collector removes its bytes. */
		readonly remove: (
			caller: Caller,
			id: string,
		) => Effect.Effect<void, Failure>
		/**
		 * The prompt of a message. Each file part must name a ready file of the
		 * caller. The prompt names the files, so the Chat does not keep their bytes.
		 */
		readonly prompt: (
			caller: Caller,
			input: MessageInput,
		) => Effect.Effect<
			Prompt.Prompt,
			Exclude<Failure, FilesApi.FileQuotaExceeded>
		>
		/** The bytes of a file for a model call, or none when the file is gone. */
		readonly load: (
			id: string,
		) => Effect.Effect<Option.Option<Content>, FilesApi.FilesUnavailable>
		/** One step of the garbage collector. Many instances can run it at the same time. */
		readonly collect: Effect.Effect<void, FilesApi.FilesUnavailable>
	}
>()("@openbot-build/openbot/files/Files") {}

const unavailable = () => FilesApi.FilesUnavailable.make({})
const notFound = (id: string) => FilesApi.FileNotFound.make({ id })
const invalid = (message: string) => FilesApi.FileInvalid.make({ message })
const tooLarge = (maxBytes: number) =>
	invalid(`The file is larger than ${maxBytes} bytes.`)
const overQuota = (quotaBytes: number, usedBytes: number, bytes: number) =>
	FilesApi.FileQuotaExceeded.make({
		message: `You may keep ${quotaBytes} bytes of files. Your files take ${usedBytes} bytes now, so a file of ${bytes} bytes does not fit. Delete some files first.`,
		quotaBytes,
		usedBytes,
	})

/** The media types of some file names, for clients that send no type. */
const extensions: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	pdf: "application/pdf",
	txt: "text/plain",
	md: "text/markdown",
	csv: "text/csv",
	json: "application/json",
}

/** `image/PNG; x=y` becomes `image/png`. */
const normalize = (mediaType: string) =>
	mediaType.split(";")[0]!.trim().toLowerCase()

const mediaTypeOf = (contentType: string, fileName: string) => {
	const given = normalize(contentType)
	if (given !== "" && given !== "application/octet-stream") return given
	const extension = fileName.split(".").pop()?.toLowerCase() ?? ""
	return extensions[extension] ?? "application/octet-stream"
}

/** `image/*` in the list takes every image. */
export const accepts = (mediaTypes: ReadonlyArray<string>, mediaType: string) =>
	mediaTypes.some((entry) => {
		const allowed = normalize(entry)
		return allowed.endsWith("/*")
			? mediaType.startsWith(allowed.slice(0, -1))
			: allowed === mediaType
	})

/** A file name without folders, as some browsers send the whole path. */
const baseName = (name: string) =>
	name.split(/[/\\]/).pop()?.slice(0, 255) || "file"

type Row = typeof files.$inferSelect

const view = (row: Row): FilesApi.FileObject => ({
	id: FilesApi.FileId.make(row.id),
	object: "file",
	filename: row.filename,
	mediaType: row.mediaType,
	bytes: row.bytes,
	status: row.status === "ready" ? "ready" : "pending",
	createdAt: row.createdAt,
})

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const settings = yield* Settings
	const secrets = yield* Secrets
	const client = yield* HttpClient.HttpClient
	const crypto = yield* Crypto.Crypto
	const stored = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.mapError(effect, unavailable)

	/** The file settings, or the defaults before `openbot setup`. */
	const config = settings.platform.pipe(
		Effect.mapError(unavailable),
		Effect.map(
			Option.match({
				onNone: () => filesDefaults,
				onSome: (snapshot) => filesOf(snapshot.document),
			}),
		),
	)
	const targetOf = (document: FilesDocument) =>
		Effect.gen(function* () {
			const storage = document.storage
			if (storage === null)
				return yield* FilesApi.FilesDisabled.make({
					message: "The platform has no file storage.",
				})
			const secretAccessKey = yield* secrets
				.open(storage.secretAccessKey, bindings.fileStorageSecret)
				.pipe(Effect.mapError(unavailable))
			return {
				target: {
					endpoint: storage.endpoint,
					region: storage.region,
					bucket: storage.bucket,
					accessKeyId: storage.accessKeyId,
					secretAccessKey,
					forcePathStyle: storage.forcePathStyle,
				} satisfies S3.Target,
				publicEndpoint: storage.publicEndpoint ?? storage.endpoint,
			}
		})
	const logged = <A>(
		effect: Effect.Effect<A, S3.StorageError, Crypto.Crypto>,
	) =>
		effect.pipe(
			Effect.provideService(Crypto.Crypto, crypto),
			Effect.tapError((error) => Effect.logWarning(error.message)),
			Effect.mapError(unavailable),
		)

	type Query = Pick<typeof db, "select">
	/** The bytes that the pending and ready files of the caller take. */
	const usedBytes = (query: Query, caller: Caller) =>
		Effect.map(
			stored(
				query
					.select({
						bytes: sql<string>`coalesce(sum(${files.bytes}), 0)`,
					})
					.from(files)
					.where(
						and(
							eq(files.organizationId, caller.organizationId),
							eq(files.userId, caller.userId),
							inArray(files.status, ["pending", "ready"]),
						),
					),
			),
			(rows) => Number(rows[0]?.bytes ?? 0),
		)
	/** Fails when a file of this size does not fit in the quota of the caller. */
	const checkRoom = (
		document: FilesDocument,
		usedBytes: number,
		bytes: number,
	) => {
		const quota = quotaOf(document)
		return quota !== null && usedBytes + bytes > quota
			? Effect.fail(overQuota(quota, usedBytes, bytes))
			: Effect.void
	}

	const owned = (caller: Caller, id: string) =>
		and(
			eq(files.id, id),
			eq(files.organizationId, caller.organizationId),
			eq(files.userId, caller.userId),
			inArray(files.status, ["pending", "ready"]),
		)
	const find = (caller: Caller, id: string) =>
		Effect.flatMap(
			stored(db.select().from(files).where(owned(caller, id))),
			(rows) =>
				rows[0] === undefined
					? Effect.fail(notFound(id))
					: Effect.succeed(rows[0]),
		)
	/**
	 * Adds a pending file. One file of a member goes in at a time, so two
	 * uploads at the same time cannot both use the last space of the quota.
	 */
	const insert = (input: {
		readonly document: FilesDocument
		readonly caller: Caller
		readonly filename: string
		readonly mediaType: string
		readonly bytes: number
		readonly now: number
	}) =>
		Effect.gen(function* () {
			const id =
				"file_" +
				Hex.encode(
					yield* crypto.randomBytes(16).pipe(Effect.mapError(unavailable)),
				)
			const row: Row = {
				id,
				organizationId: input.caller.organizationId,
				userId: input.caller.userId,
				filename: input.filename,
				mediaType: input.mediaType,
				bytes: input.bytes,
				status: "pending",
				objectKey: "files/" + id,
				createdAt: input.now,
				updatedAt: input.now,
			}
			const { organizationId, userId } = input.caller
			yield* db
				.transaction((tx) =>
					Effect.gen(function* () {
						yield* stored(
							tx.execute(
								sql`SELECT pg_advisory_xact_lock(hashtextextended(${"openbot-files:" + organizationId + ":" + userId}, 0))`,
							),
						)
						const used = yield* usedBytes(tx, input.caller)
						yield* checkRoom(input.document, used, input.bytes)
						yield* stored(tx.insert(files).values(row))
					}),
				)
				.pipe(Effect.catchTag("SqlError", () => Effect.fail(unavailable())))
			return row
		})
	const setStatus = (id: string, from: string, to: string) =>
		Effect.flatMap(Clock.currentTimeMillis, (now) =>
			stored(
				db
					.update(files)
					.set({ status: to, updatedAt: now })
					.where(and(eq(files.id, id), eq(files.status, from)))
					.returning(),
			),
		)
	const checkFile = (
		document: FilesDocument,
		mediaType: string,
		bytes: number,
	) =>
		bytes > document.maxBytes
			? Effect.fail(tooLarge(document.maxBytes))
			: accepts(document.mediaTypes, mediaType)
				? Effect.void
				: Effect.fail(
						invalid(`The platform does not take files of type ${mediaType}.`),
					)

	/**
	 * Reads the bytes of one part, and stops when there are more than the
	 * largest file, or more than the space that is left in the quota.
	 */
	const readPart = (
		part: Multipart.File,
		document: FilesDocument,
		usedBytes: number,
	) =>
		Effect.gen(function* () {
			const size = yield* Ref.make(0)
			const chunks = yield* part.content.pipe(
				Stream.tap((chunk) =>
					Effect.flatMap(
						Ref.updateAndGet(size, (total) => total + chunk.length),
						(total): Effect.Effect<void, Failure> =>
							total > document.maxBytes
								? Effect.fail(tooLarge(document.maxBytes))
								: checkRoom(document, usedBytes, total),
					),
				),
				Stream.runCollect,
			)
			return Buffer.concat(chunks)
		})

	const loadNow = (id: string) =>
		Effect.gen(function* () {
			const row = (yield* stored(
				db
					.select()
					.from(files)
					.where(and(eq(files.id, id), eq(files.status, "ready"))),
			))[0]
			if (row === undefined) return Option.none<Content>()
			const document = yield* config
			const { target } = yield* targetOf(document).pipe(
				Effect.catchTag("FilesDisabled", () => Effect.fail(unavailable())),
			)
			const now = yield* Clock.currentTimeMillis
			const bytes = yield* logged(S3.get(client, target, row.objectKey, now))
			return Option.map(bytes, (bytes): Content => ({
				mediaType: row.mediaType,
				fileName: row.filename,
				bytes,
			}))
		})
	// The steps of one Turn send the same files again. A short cache keeps them
	// from storage, and a failure is not kept.
	const cache = yield* Cache.makeWith(loadNow, {
		capacity: 16,
		timeToLive: (exit) =>
			Exit.isSuccess(exit) ? Duration.minutes(5) : Duration.zero,
	})

	return Files.of({
		upload: (caller, parts) =>
			Effect.gen(function* () {
				const document = yield* config
				if (!document.uploads.server)
					return yield* FilesApi.FilesDisabled.make({
						message:
							"Uploads through OpenBot are off. Use POST /v1/files/uploads.",
					})
				const { target } = yield* targetOf(document)
				const used = yield* usedBytes(db, caller)
				const found = yield* parts.pipe(
					Stream.runFoldEffect(
						() => Option.none<Content>(),
						(found, part) =>
							!Multipart.isFile(part)
								? Effect.succeed(found)
								: part.key !== "file" || Option.isSome(found)
									? Effect.as(Stream.runDrain(part.content), found)
									: Effect.map(readPart(part, document, used), (bytes) =>
											Option.some({
												fileName: baseName(part.name),
												mediaType: mediaTypeOf(part.contentType, part.name),
												bytes,
											}),
										),
					),
					Effect.mapError((error) =>
						error instanceof FilesApi.FileInvalid ||
						error instanceof FilesApi.FileQuotaExceeded
							? error
							: invalid("The body is not a valid multipart form."),
					),
				)
				if (Option.isNone(found))
					return yield* invalid("The form has no file in the field `file`.")
				const file = found.value
				yield* checkFile(document, file.mediaType, file.bytes.length)
				const now = yield* Clock.currentTimeMillis
				const row = yield* insert({
					document,
					caller,
					filename: file.fileName,
					mediaType: file.mediaType,
					bytes: file.bytes.length,
					now,
				})
				// When the bytes do not arrive, the pending row stays. The
				// garbage collector removes it, and any bytes, later.
				yield* logged(
					S3.put(
						client,
						target,
						row.objectKey,
						{ bytes: file.bytes, contentType: file.mediaType },
						now,
					),
				)
				const ready = yield* setStatus(row.id, "pending", "ready")
				if (ready[0] === undefined) return yield* notFound(row.id)
				return view(ready[0])
			}),
		createUpload: (caller, input) =>
			Effect.gen(function* () {
				const document = yield* config
				if (!document.uploads.direct)
					return yield* FilesApi.FilesDisabled.make({
						message: "Direct uploads are off. Use POST /v1/files.",
					})
				const { target, publicEndpoint } = yield* targetOf(document)
				const mediaType = normalize(input.mediaType)
				yield* checkFile(document, mediaType, input.bytes)
				const now = yield* Clock.currentTimeMillis
				const row = yield* insert({
					document,
					caller,
					filename: baseName(input.filename),
					mediaType,
					bytes: input.bytes,
					now,
				})
				// The signature covers the type and the size, so storage takes no other bytes.
				const headers = {
					"content-type": mediaType,
					"content-length": String(input.bytes),
				}
				return {
					file: view(row),
					url: yield* logged(
						S3.presign({
							target,
							method: "PUT",
							key: row.objectKey,
							endpoint: publicEndpoint,
							headers,
							expiresSeconds: uploadLifetimeSeconds,
							now,
						}),
					),
					method: "PUT" as const,
					headers,
					expiresAt: now + uploadLifetimeSeconds * 1000,
				}
			}),
		complete: (caller, id) =>
			Effect.gen(function* () {
				const row = yield* find(caller, id)
				if (row.status === "ready") return view(row)
				const document = yield* config
				const { target } = yield* targetOf(document)
				const now = yield* Clock.currentTimeMillis
				const head = yield* logged(S3.head(client, target, row.objectKey, now))
				if (Option.isNone(head))
					return yield* invalid("The bytes of the file are not in storage yet.")
				if (head.value.bytes !== row.bytes) {
					yield* setStatus(row.id, "pending", "deleting")
					return yield* invalid(
						`The file has ${head.value.bytes} bytes, not ${row.bytes}. Make a new upload.`,
					)
				}
				const ready = yield* setStatus(row.id, "pending", "ready")
				return ready[0] === undefined
					? view(yield* find(caller, id))
					: view(ready[0])
			}),
		list: (caller, query) =>
			Effect.gen(function* () {
				const limit = query.limit ?? 50
				const after =
					query.after === undefined
						? undefined
						: (yield* stored(
								db
									.select({ createdAt: files.createdAt })
									.from(files)
									.where(eq(files.id, query.after)),
							))[0]
				const rows = yield* stored(
					db
						.select()
						.from(files)
						.where(
							and(
								eq(files.organizationId, caller.organizationId),
								eq(files.userId, caller.userId),
								inArray(files.status, ["pending", "ready"]),
								after === undefined || query.after === undefined
									? undefined
									: sql`(${files.createdAt}, ${files.id}) < (${after.createdAt}, ${query.after})`,
							),
						)
						.orderBy(desc(files.createdAt), desc(files.id))
						.limit(limit + 1),
				)
				const page = rows.slice(0, limit)
				return {
					items: page.map(view),
					next:
						rows.length > limit
							? FilesApi.FileId.make(page[page.length - 1]!.id)
							: null,
				}
			}),
		get: (caller, id) => Effect.map(find(caller, id), view),
		content: (caller, id) =>
			Effect.gen(function* () {
				const row = yield* find(caller, id)
				if (row.status !== "ready")
					return yield* invalid("The file is not ready.")
				const document = yield* config
				const { target } = yield* targetOf(document)
				const now = yield* Clock.currentTimeMillis
				const bytes = yield* logged(S3.get(client, target, row.objectKey, now))
				if (Option.isNone(bytes)) return yield* notFound(id)
				return bytes.value
			}),
		remove: (caller, id) =>
			Effect.gen(function* () {
				const row = yield* find(caller, id)
				yield* setStatus(row.id, row.status, "deleting")
				yield* Cache.invalidate(cache, id)
			}),
		prompt: (caller, input) =>
			Effect.gen(function* () {
				if (Predicate.isString(input)) return Prompt.make(input)
				const ids = [
					...new Set(
						input.flatMap((message) =>
							Predicate.isString(message.content)
								? []
								: message.content.flatMap((part) =>
										part.type === "input_text" ? [] : [part.file_id],
									),
						),
					),
				]
				const now = yield* Clock.currentTimeMillis
				// A file in a new message counts as used now, so the garbage
				// collector waits again before it takes a file that no Chat names yet.
				const rows =
					ids.length === 0
						? []
						: yield* stored(
								db
									.update(files)
									.set({ updatedAt: now })
									.where(
										and(
											inArray(files.id, ids),
											eq(files.organizationId, caller.organizationId),
											eq(files.userId, caller.userId),
											eq(files.status, "ready"),
										),
									)
									.returning(),
							)
				const byId = new Map(rows.map((row) => [row.id, row]))
				const messages = yield* Effect.forEach(input, (message) =>
					Effect.gen(function* () {
						const parts = Predicate.isString(message.content)
							? [Prompt.makePart("text", { text: message.content })]
							: yield* Effect.forEach(
									message.content,
									(
										part,
									): Effect.Effect<
										Prompt.TextPart | Prompt.FilePart,
										FilesApi.FileInvalid
									> => {
										if (part.type === "input_text")
											return Effect.succeed(
												Prompt.makePart("text", { text: part.text }),
											)
										const row = byId.get(part.file_id)
										if (row === undefined)
											return Effect.fail(
												invalid(
													`The file ${part.file_id} is not one of your ready files.`,
												),
											)
										if (
											part.type === "input_image" &&
											!row.mediaType.startsWith("image/")
										)
											return Effect.fail(
												invalid(`The file ${part.file_id} is not an image.`),
											)
										return Effect.succeed(
											Prompt.makePart("file", {
												mediaType: row.mediaType,
												fileName: row.filename,
												data: fileUrl(row.id),
											}),
										)
									},
								)
						return Prompt.makeMessage("user", { content: parts })
					}),
				)
				return Prompt.fromMessages(messages)
			}),
		load: (id) => Cache.get(cache, id),
		collect: Effect.gen(function* () {
			const document = yield* config
			const now = yield* Clock.currentTimeMillis
			yield* stored(
				db
					.update(files)
					.set({ status: "deleting", updatedAt: now })
					.where(
						and(
							eq(files.status, "pending"),
							lt(files.updatedAt, now - pendingLifetimeMs),
						),
					),
			)
			yield* stored(
				db
					.update(files)
					.set({ status: "deleting", updatedAt: now })
					.where(
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
			)
			// Without storage, the rows wait until there is storage again.
			if (document.storage === null) return
			const { target } = yield* targetOf(document).pipe(
				Effect.catchTag("FilesDisabled", () => Effect.fail(unavailable())),
			)
			const doomed = yield* stored(
				db
					.select({ id: files.id, objectKey: files.objectKey })
					.from(files)
					.where(eq(files.status, "deleting"))
					.orderBy(files.updatedAt)
					.limit(deleteBatch),
			)
			// Deleting an object twice is safe, so other instances may do the same rows.
			yield* Effect.forEach(
				doomed,
				(row) =>
					Effect.gen(function* () {
						yield* logged(S3.remove(client, target, row.objectKey, now))
						yield* stored(
							db
								.delete(files)
								.where(and(eq(files.id, row.id), eq(files.status, "deleting"))),
						)
						yield* Cache.invalidate(cache, row.id)
					}),
				{ concurrency: 4, discard: true },
			)
		}),
	})
})

export const layer = Layer.effect(Files, make)
