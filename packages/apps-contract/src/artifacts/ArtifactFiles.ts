import type { ExecutionIdentity } from "@openbot-build/domain/Identity"
import { Files as FileData, Execution } from "@openbot-build/domain"
import { Context, type Effect, type Option, type Stream } from "effect"
import type { files } from "@openbot-build/server-database/Schema"
type StoredFile = typeof files.$inferSelect
type Failure =
	| FileData.FilesUnavailable
	| FileData.FileNotFound
	| FileData.FileInvalid
	| FileData.FileQuotaExceeded
	| Execution.StorageError
export interface Reservation {
	readonly id: string
	readonly identity: ExecutionIdentity
	readonly namespace: string
	readonly chat: string
	readonly executionId: string
	readonly filename: string
	readonly mediaType: string
	readonly bytes: number
}
export interface Service {
	readonly get: (
		id: string,
	) => Effect.Effect<Option.Option<StoredFile>, FileData.FilesUnavailable>
	readonly reserve: (input: Reservation) => Effect.Effect<void, Failure>
	readonly put: (
		id: string,
		bytes: Uint8Array,
		mediaType: string,
	) => Effect.Effect<void, FileData.FilesUnavailable>
	readonly read: (
		id: string,
	) => Effect.Effect<Option.Option<Uint8Array>, FileData.FilesUnavailable>
	readonly content: (
		id: string,
	) => Effect.Effect<
		Stream.Stream<Uint8Array, FileData.FilesUnavailable>,
		FileData.FilesUnavailable | FileData.FileNotFound
	>
}

export class ArtifactFiles extends Context.Service<ArtifactFiles, Service>()(
	"@openbot-build/apps-contract/artifacts/ArtifactFiles",
) {}
