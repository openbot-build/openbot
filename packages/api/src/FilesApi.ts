import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { Multipart } from "effect/http"
import { BotAuth } from "./AuthApi.ts"
import { Authorize, Required, own } from "./Authorization.ts"

export const FileId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/api/FileId"))
export type FileId = typeof FileId.Type

/** A file name, without a folder. */
export const FileName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(255),
)
/** A media type, such as `image/png`. */
export const MediaType = Schema.String.check(
	Schema.isMinLength(3),
	Schema.isMaxLength(255),
	Schema.isPattern(/^[\w.+-]+\/[\w.+-]+$/),
)

/**
 * `pending` means that the bytes are not in storage yet.
 * Only a `ready` file can go into a message.
 */
export const FileStatus = Schema.Literals(["pending", "ready"])
export type FileStatus = typeof FileStatus.Type

/** A file that a member gave to OpenBot. Its bytes are in the object storage of the platform. */
export const FileObject = Schema.Struct({
	id: FileId,
	object: Schema.Literal("file"),
	filename: Schema.String,
	mediaType: Schema.String,
	/** The size in bytes. */
	bytes: Schema.Natural,
	status: FileStatus,
	createdAt: Schema.Finite,
})
export type FileObject = typeof FileObject.Type

/**
 * An upload through the server. `file` is the file. The form may have other
 * fields, such as `purpose` for OpenAI clients. OpenBot does not use them.
 */
export const UploadFileRequest = Schema.Struct({
	file: Multipart.SingleFileSchema,
}).pipe(HttpApiSchema.asMultipartStream())

/** Asks for an address where the client puts the bytes itself. */
export const CreateUploadRequest = Schema.Struct({
	filename: FileName,
	mediaType: MediaType,
	/** The exact size in bytes. Storage takes only this size. */
	bytes: Schema.Int.check(Schema.isGreaterThan(0)),
})
export type CreateUploadRequest = typeof CreateUploadRequest.Type

/**
 * Send the bytes with `PUT` to `url`, with these headers. Then call
 * `POST /v1/files/:fileId/complete`.
 */
export const DirectUpload = Schema.Struct({
	file: FileObject,
	url: Schema.String,
	method: Schema.Literal("PUT"),
	headers: Schema.Record(Schema.String, Schema.String),
	expiresAt: Schema.Finite,
})
export type DirectUpload = typeof DirectUpload.Type

export const ListFilesQuery = Schema.Struct({
	limit: Schema.optionalKey(
		Schema.NumberFromString.check(
			Schema.isInt(),
			Schema.isBetween({ minimum: 1, maximum: 100 }),
		),
	),
	/** The `next` value of the page before. */
	after: Schema.optionalKey(FileId),
})
export const FilePage = Schema.Struct({
	items: Schema.Array(FileObject),
	next: Schema.NullOr(FileId),
})
export type FilePage = typeof FilePage.Type

export class FileNotFound extends Schema.TaggedError<FileNotFound>()(
	"FileNotFound",
	{ id: Schema.String },
) {}
/** The file is too large, has a media type that the platform does not take, or is not ready. */
export class FileInvalid extends Schema.TaggedError<FileInvalid>()(
	"FileInvalid",
	{ message: Schema.String },
) {}
/** The file does not fit in the space that is left to the member. */
export class FileQuotaExceeded extends Schema.TaggedError<FileQuotaExceeded>()(
	"FileQuotaExceeded",
	{
		message: Schema.String,
		/** The most bytes that the member may keep. */
		quotaBytes: Schema.Natural,
		/** The bytes that the files of the member take now. */
		usedBytes: Schema.Natural,
	},
) {}
/** The platform has no object storage, or this way of upload is off. */
export class FilesDisabled extends Schema.TaggedError<FilesDisabled>()(
	"FilesDisabled",
	{ message: Schema.String },
) {}
export class FilesUnavailable extends Schema.TaggedError<FilesUnavailable>()(
	"FilesUnavailable",
	{},
) {}

export const FileErrors = [
	FileNotFound.pipe(HttpApiSchema.status(404)),
	FileInvalid.pipe(HttpApiSchema.status(400)),
	FileQuotaExceeded.pipe(HttpApiSchema.status(413)),
	FilesDisabled.pipe(HttpApiSchema.status(409)),
	FilesUnavailable.pipe(HttpApiSchema.status(503)),
] as const

const fileParams = { fileId: FileId }
const read = [own("read", "File")]
const write = [own("write", "File")]
const readOne = [own("read", "File", "fileId")]
const writeOne = [own("write", "File", "fileId")]

export class FilesApi extends HttpApiGroup.make("files")
	.add(
		HttpApiEndpoint.post("uploadFile", "/v1/files", {
			payload: UploadFileRequest,
			success: FileObject.pipe(HttpApiSchema.status(201)),
			error: FileErrors,
		})
			.annotate(Required, write)
			.annotate(
				OpenApi.Description,
				"Uploads one file through OpenBot, as `multipart/form-data` with the field `file`. The file is ready at once. The platform can turn this way off.",
			),
		HttpApiEndpoint.post("createUpload", "/v1/files/uploads", {
			payload: CreateUploadRequest,
			success: DirectUpload.pipe(HttpApiSchema.status(201)),
			error: FileErrors,
		})
			.annotate(Required, write)
			.annotate(
				OpenApi.Description,
				"Makes a pending file and a signed address in object storage. The client puts the bytes there itself, then completes the file. The platform can turn this way off.",
			),
		HttpApiEndpoint.post("completeUpload", "/v1/files/:fileId/complete", {
			params: fileParams,
			success: FileObject,
			error: FileErrors,
		})
			.annotate(Required, writeOne)
			.annotate(
				OpenApi.Description,
				"Checks that the bytes are in object storage with the right size, and makes the file ready.",
			),
		HttpApiEndpoint.get("listFiles", "/v1/files", {
			query: ListFilesQuery,
			success: FilePage,
			error: FileErrors,
		})
			.annotate(Required, read)
			.annotate(OpenApi.Description, "Lists your files, newest first."),
		HttpApiEndpoint.get("getFile", "/v1/files/:fileId", {
			params: fileParams,
			success: FileObject,
			error: FileErrors,
		}).annotate(Required, readOne),
		HttpApiEndpoint.get("getFileContent", "/v1/files/:fileId/content", {
			params: fileParams,
			success: HttpApiSchema.StreamUint8Array({
				contentType: "application/octet-stream",
			}),
			error: FileErrors,
		})
			.annotate(Required, readOne)
			.annotate(OpenApi.Description, "Gives the bytes of a ready file."),
		HttpApiEndpoint.delete("deleteFile", "/v1/files/:fileId", {
			params: fileParams,
			success: HttpApiSchema.NoContent,
			error: FileErrors,
		})
			.annotate(Required, writeOne)
			.annotate(
				OpenApi.Description,
				"Deletes a file now. Chats that used it keep their text, but the model no longer sees the file.",
			),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	.middleware(Authorize)
	.middleware(BotAuth) {}
