import { Files as FilesApi, type MessageInput } from "@openbot-build/domain"
import { Authorization, Execution, type Caller } from "@openbot-build/domain"
import { Context, Effect, Option, Stream } from "effect"
import { Prompt } from "effect/ai"
import { Multipart } from "effect/http"

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
		) => Effect.Effect<
			FilesApi.FilePage,
			Failure | Authorization.PolicyUnavailable
		>
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
		) => Effect.Effect<
			void,
			| Failure
			| Execution.Forbidden
			| Execution.StorageError
			| Execution.Conflict
			| Execution.KeyConflict
			| Execution.NotFound
		>
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
	}
	// @effect-diagnostics-next-line deterministicKeys:off -- The key keeps the name it had in the openbot package, so code built for that name still finds this service.
>()("@openbot-build/openbot/apps-contract/files/Files") {}

export { type Failure }
