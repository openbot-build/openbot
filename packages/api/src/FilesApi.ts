import { errors as ExecutionErrors } from "./ExecutionsApi.ts"
import { Files } from "@openbot-build/domain"
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
import {
	Authorize,
	AuthorizationErrors,
	Required,
	own,
} from "./Authorization.ts"
import { Limit } from "./Page.ts"

export const FileId = Files.FileId
export type FileId = typeof FileId.Type
export const FileName = Files.FileName
export type FileName = typeof FileName.Type
export const MediaType = Files.MediaType
export type MediaType = typeof MediaType.Type
export const FileStatus = Files.FileStatus
export type FileStatus = typeof FileStatus.Type
export const FileObject = Files.FileObject
export type FileObject = typeof FileObject.Type

/**
 * An upload through the server. `file` is the file. The form may have other
 * fields, such as `purpose` for OpenAI clients. OpenBot does not use them.
 */
export const UploadFileRequest = Schema.Struct({
	file: Multipart.SingleFileSchema,
}).pipe(HttpApiSchema.asMultipartStream())

/** Asks for an address where the client puts the bytes itself. */
export const CreateUploadRequest = Files.CreateUploadRequest
export type CreateUploadRequest = Files.CreateUploadRequest

/**
 * Send the bytes with `PUT` to `url`, with these headers. Then call
 * `POST /v1/files/:fileId/complete`.
 */
export const DirectUpload = Files.DirectUpload
export type DirectUpload = Files.DirectUpload

export const ListFilesQuery = Schema.Struct({
	limit: Schema.optionalKey(Limit(100)),
	/** The `next` value of the page before. */
	after: Schema.optionalKey(FileId),
})
export const FilePage = Files.FilePage
export type FilePage = Files.FilePage

export const FileNotFound = Files.FileNotFound
export type FileNotFound = Files.FileNotFound
export const FileInvalid = Files.FileInvalid
export type FileInvalid = Files.FileInvalid
export const FileQuotaExceeded = Files.FileQuotaExceeded
export type FileQuotaExceeded = Files.FileQuotaExceeded
export const FilesDisabled = Files.FilesDisabled
export type FilesDisabled = Files.FilesDisabled
export const FilesUnavailable = Files.FilesUnavailable
export type FilesUnavailable = Files.FilesUnavailable

export const FileErrors = [
	FileNotFound.pipe(HttpApiSchema.status(404)),
	FileInvalid.pipe(HttpApiSchema.status(400)),
	FileQuotaExceeded.pipe(HttpApiSchema.status(413)),
	FilesDisabled.pipe(HttpApiSchema.status(409)),
	FilesUnavailable.pipe(HttpApiSchema.status(503)),
] as const

const fileParams = { fileId: FileId }
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
			error: [...FileErrors, ...AuthorizationErrors],
		})
			.annotate(Required, [])
			.annotate(
				OpenApi.Description,
				"Lists the files that you may read, newest first.",
			),
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
			error: [...FileErrors, ...ExecutionErrors],
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
