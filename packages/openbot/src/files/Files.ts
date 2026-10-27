import { type Caller, FilesApi, type MessageInput } from "@openbot-build/api"
import { and, desc, eq, inArray, lt, notExists, sql } from "drizzle-orm"
import {
	Array as Arr,
	Cache,
	Cause,
	Clock,
	Context,
	Crypto,
	Duration,
	Effect,
	Exit,
	Layer,
	Option,
	Predicate,
	Record as Rec,
	Redacted,
	Ref,
	Stream,
	String as Str,
	pipe,
} from "effect"
import { Prompt } from "effect/ai"
import { Hex } from "effect/encoding"
import { HttpClient, Multipart } from "effect/http"
import * as Failures from "../app/Failures.ts"
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
		/**
		 * The bytes of a ready file, as they come from storage. A failure of
		 * storage in the middle of the stream is logged, and the stream fails.
		 */
		readonly content: (
			caller: Caller,
			id: string,
		) => Effect.Effect<
			Stream.Stream<Uint8Array, FilesApi.FilesUnavailable>,
			Failure
		>
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
	pipe(mediaType, Str.split(";"), Arr.headNonEmpty, Str.trim, Str.toLowerCase)

const mediaTypeOf = (contentType: string, fileName: string) => {
	const given = normalize(contentType)
	if (given !== "" && given !== "application/octet-stream") return given
	const extension = pipe(
		fileName,
		Str.split("."),
		Arr.lastNonEmpty,
		Str.toLowerCase,
	)
	// `Rec.get` reads only own keys, so a name such as `a.constructor` gets no value.
	return pipe(
		Rec.get(extensions, extension),
		Option.getOrElse(() => "application/octet-stream"),
	)
}

/** `image/*` in the list takes every image. */
export const accepts = (mediaTypes: ReadonlyArray<string>, mediaType: string) =>
	Arr.some(mediaTypes, (entry) => {
		const allowed = normalize(entry)
		return Str.endsWith("/*")(allowed)
			? Str.startsWith(Str.slice(0, -1)(allowed))(mediaType)
			: allowed === mediaType
	})

/** A file name without folders, as some browsers send the whole path. */
const baseName = (name: string) =>
	pipe(name, Str.split(/[/\\]/), Arr.lastNonEmpty, Str.slice(0, 255)) || "file"

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
	const stored = Failures.replace("A file query failed", () =>
		FilesApi.FilesUnavailable.make({}),
	)

	/** The file settings, or the defaults before `openbot setup`. */
	const config = settings.platform.pipe(
		Failures.replace("Could not read the file settings", () =>
			FilesApi.FilesUnavailable.make({}),
		),
		Effect.map(
			Option.match({
				onNone: () => filesDefaults,
				onSome: (snapshot) => filesOf(snapshot.document),
			}),
		),
	)
	/** The storage target of storage settings that are there. */
	const targetFor = (storage: NonNullable<FilesDocument["storage"]>) =>
		Effect.gen(function* () {
			const secretAccessKey = yield* secrets
				.open(storage.secretAccessKey, bindings.fileStorageSecret)
				.pipe(
					Failures.replace("Could not open the key of the file storage", () =>
						FilesApi.FilesUnavailable.make({}),
					),
				)
			return {
				target: {
					endpoint: storage.endpoint,
					region: storage.region,
					bucket: storage.bucket,
					accessKeyId: storage.accessKeyId,
					secretAccessKey: Redacted.make(secretAccessKey),
					forcePathStyle: storage.forcePathStyle,
				} satisfies S3.Target,
				publicEndpoint: storage.publicEndpoint ?? storage.endpoint,
			}
		})
	const targetOf = (document: FilesDocument) =>
		Effect.gen(function* () {
			if (document.storage === null)
				return yield* FilesApi.FilesDisabled.make({
					message: "The platform has no file storage.",
				})
			return yield* targetFor(document.storage)
		})
	const logged = <A>(
		effect: Effect.Effect<A, S3.StorageError, Crypto.Crypto>,
	) =>
		effect.pipe(
			Effect.provideService(Crypto.Crypto, crypto),
			Failures.replace("The file storage failed", () =>
				FilesApi.FilesUnavailable.make({}),
			),
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
			? Effect.fail(
					FilesApi.FileQuotaExceeded.make({
						message: `You may keep ${quota} bytes of files. Your files take ${usedBytes} bytes now, so a file of ${bytes} bytes does not fit. Delete some files first.`,
						quotaBytes: quota,
						usedBytes,
					}),
				)
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
					? Effect.fail(FilesApi.FileNotFound.make({ id }))
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
				"file_" + Hex.encode(yield* Effect.orDie(crypto.randomBytes(16)))
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
				.pipe(
					Failures.replaceTag("SqlError", "A file transaction failed", () =>
						FilesApi.FilesUnavailable.make({}),
					),
				)
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
			? Effect.fail(
					FilesApi.FileInvalid.make({
						message: `The file is larger than ${document.maxBytes} bytes.`,
					}),
				)
			: accepts(document.mediaTypes, mediaType)
				? Effect.void
				: Effect.fail(
						FilesApi.FileInvalid.make({
							message: `The platform does not take files of type ${mediaType}.`,
						}),
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
								? Effect.fail(
										FilesApi.FileInvalid.make({
											message: `The file is larger than ${document.maxBytes} bytes.`,
										}),
									)
								: checkRoom(document, usedBytes, total),
					),
				),
				Stream.runCollect,
			)
			return Buffer.concat(chunks)
		})

	/** The bytes of a stored object, or none when storage does not have it. */
	const bytesOf = (objectKey: string) =>
		Effect.gen(function* () {
			const document = yield* config
			// An admin took the storage away after the upload. A model call cannot act on that.
			const { target } = yield* targetOf(document).pipe(
				Failures.replaceTag(
					"FilesDisabled",
					"A ready file was asked for, but the platform has no file storage",
					() => FilesApi.FilesUnavailable.make({}),
				),
			)
			const now = yield* Clock.currentTimeMillis
			return yield* logged(S3.get(client, target, objectKey, now))
		})
	// The steps of one Turn send the same files again. A short cache keeps their
	// bytes from storage, and a failure is not kept. The row is read each time,
	// so a delete on any instance takes effect at once.
	const cache = yield* Cache.makeWith(bytesOf, {
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
					Effect.catchTag("MultipartError", (error) =>
						Effect.andThen(
							Effect.logInfo(
								"The multipart form is not valid",
								Cause.fail(error),
							),
							Effect.fail(
								FilesApi.FileInvalid.make({
									message: "The body is not a valid multipart form.",
								}),
							),
						),
					),
				)
				if (Option.isNone(found))
					return yield* FilesApi.FileInvalid.make({
						message: "The form has no file in the field `file`.",
					})
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
				if (ready[0] === undefined)
					return yield* FilesApi.FileNotFound.make({ id: row.id })
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
					return yield* FilesApi.FileInvalid.make({
						message: "The bytes of the file are not in storage yet.",
					})
				if (head.value.bytes !== row.bytes) {
					yield* setStatus(row.id, "pending", "deleting")
					return yield* FilesApi.FileInvalid.make({
						message: `The file has ${head.value.bytes} bytes, not ${row.bytes}. Make a new upload.`,
					})
				}
				const ready = yield* setStatus(row.id, "pending", "ready")
				return ready[0] === undefined
					? view(yield* find(caller, id))
					: view(ready[0])
			}),
		list: (caller, query) =>
			Effect.gen(function* () {
				const limit = query.limit ?? 50
				// A file that was deleted after the page before still works as the
				// cursor while its row is there, so the owner is checked but not the status.
				const after =
					query.after === undefined
						? undefined
						: (yield* stored(
								db
									.select({ createdAt: files.createdAt })
									.from(files)
									.where(
										and(
											eq(files.id, query.after),
											eq(files.organizationId, caller.organizationId),
											eq(files.userId, caller.userId),
										),
									),
							))[0]
				if (query.after !== undefined && after === undefined)
					return yield* FilesApi.FileInvalid.make({
						message: `The cursor ${query.after} names none of your files. Ask for the list again without after.`,
					})
				const rows = yield* stored(
					db
						.select()
						.from(files)
						.where(
							and(
								eq(files.organizationId, caller.organizationId),
								eq(files.userId, caller.userId),
								inArray(files.status, ["pending", "ready"]),
								after === undefined
									? undefined
									: sql`(${files.createdAt}, ${files.id}) < (${after.createdAt}, ${query.after})`,
							),
						)
						.orderBy(desc(files.createdAt), desc(files.id))
						.limit(limit + 1),
				)
				const page = rows.slice(0, limit)
				return {
					items: Arr.map(page, view),
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
					return yield* FilesApi.FileInvalid.make({
						message: "The file is not ready.",
					})
				const document = yield* config
				const { target } = yield* targetOf(document)
				const now = yield* Clock.currentTimeMillis
				const bytes = yield* logged(
					S3.getStream(client, target, row.objectKey, now),
				)
				if (Option.isNone(bytes))
					return yield* FilesApi.FileNotFound.make({ id })
				return Stream.catch(bytes.value, (error) =>
					Stream.fromEffect(logged(Effect.fail(error))),
				)
			}),
		remove: (caller, id) =>
			Effect.gen(function* () {
				const row = yield* find(caller, id)
				yield* setStatus(row.id, row.status, "deleting")
				yield* Cache.invalidate(cache, row.objectKey)
			}),
		prompt: (caller, input) =>
			Effect.gen(function* () {
				if (Predicate.isString(input)) return Prompt.make(input)
				const ids = Arr.dedupe(
					Arr.flatMap(input, (message) =>
						Predicate.isString(message.content)
							? []
							: Arr.flatMap(message.content, (part) =>
									part.type === "input_text" ? [] : [part.file_id],
								),
					),
				)
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
				const byId = Rec.fromIterableBy(rows, (row) => row.id)
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
										const found = Rec.get(byId, part.file_id)
										if (Option.isNone(found))
											return Effect.fail(
												FilesApi.FileInvalid.make({
													message: `The file ${part.file_id} is not one of your ready files.`,
												}),
											)
										const row = found.value
										if (
											part.type === "input_image" &&
											!Str.startsWith("image/")(row.mediaType)
										)
											return Effect.fail(
												FilesApi.FileInvalid.make({
													message: `The file ${part.file_id} is not an image.`,
												}),
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
		load: (id) =>
			Effect.gen(function* () {
				const row = (yield* stored(
					db
						.select()
						.from(files)
						.where(and(eq(files.id, id), eq(files.status, "ready"))),
				))[0]
				if (row === undefined) return Option.none<Content>()
				const bytes = yield* Cache.get(cache, row.objectKey)
				return Option.map(bytes, (bytes): Content => ({
					mediaType: row.mediaType,
					fileName: row.filename,
					bytes,
				}))
			}),
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
			const { target } = yield* targetFor(document.storage)
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
						const doomedRow = and(
							eq(files.id, row.id),
							eq(files.status, "deleting"),
						)
						// An object that storage will not delete goes to the back, so it
						// cannot stop the other rows.
						yield* logged(S3.remove(client, target, row.objectKey, now)).pipe(
							Effect.tapError(() =>
								stored(
									db.update(files).set({ updatedAt: now }).where(doomedRow),
								),
							),
						)
						yield* stored(db.delete(files).where(doomedRow))
						yield* Cache.invalidate(cache, row.objectKey)
					}).pipe(
						Effect.annotateLogs({ file: row.id, objectKey: row.objectKey }),
					),
				{ concurrency: 4, discard: true },
			)
		}),
	})
})

export const layer = Layer.effect(Files, make)
