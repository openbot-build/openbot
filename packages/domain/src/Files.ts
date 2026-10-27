import { Schema } from "effect"

export const FileId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/domain/FileId"))
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

export const CreateUploadRequest = Schema.Struct({
	filename: FileName,
	mediaType: MediaType,
	/** The exact size in bytes. Storage takes only this size. */
	bytes: Schema.Int.check(Schema.isGreaterThan(0)),
})
export type CreateUploadRequest = typeof CreateUploadRequest.Type
export class FileNotFound extends Schema.TaggedError<
	FileNotFound,
	{ readonly brand: unique symbol }
>()("FileNotFound", { id: Schema.String }) {}
/** The file is too large, has a media type that the platform does not take, or is not ready. */
export class FileInvalid extends Schema.TaggedError<
	FileInvalid,
	{ readonly brand: unique symbol }
>()("FileInvalid", { message: Schema.String }) {}
/** The file does not fit in the space that is left to the member. */
export class FileQuotaExceeded extends Schema.TaggedError<
	FileQuotaExceeded,
	{ readonly brand: unique symbol }
>()("FileQuotaExceeded", {
	message: Schema.String,
	/** The most bytes that the member may keep. */
	quotaBytes: Schema.Natural,
	/** The bytes that the files of the member take now. */
	usedBytes: Schema.Natural,
}) {}
/** The platform has no object storage, or this way of upload is off. */
export class FilesDisabled extends Schema.TaggedError<
	FilesDisabled,
	{ readonly brand: unique symbol }
>()("FilesDisabled", { message: Schema.String }) {}
export class FilesUnavailable extends Schema.TaggedError<
	FilesUnavailable,
	{ readonly brand: unique symbol }
>()("FilesUnavailable", {}) {}

export const DirectUpload = Schema.Struct({
	file: FileObject,
	url: Schema.String,
	method: Schema.Literal("PUT"),
	headers: Schema.Record(Schema.String, Schema.String),
	expiresAt: Schema.Finite,
})
export type DirectUpload = typeof DirectUpload.Type

export const FilePage = Schema.Struct({
	items: Schema.Array(FileObject),
	next: Schema.NullOr(FileId),
})
export type FilePage = typeof FilePage.Type

/** A pending upload keeps its row for one hour. */
export const pendingLifetimeMs = 60 * 60 * 1000
