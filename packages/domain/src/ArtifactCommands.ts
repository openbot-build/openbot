import { Item, Turn } from "@openbot-build/core"
import { Schema } from "effect"
import {
	ArtifactFrom,
	SourceFrom,
	SourceReference,
	Version,
} from "./Artifacts.ts"
import { CommandKey } from "./Execution.ts"
import { FileName, MediaType } from "./Files.ts"

/** A generated file is published from text or an allowed Computer. */
export const PublishArtifactRequest = Schema.Struct({
	commandKey: CommandKey,
	title: Schema.NonEmptyString,
	filename: FileName,
	mediaType: MediaType,
	from: ArtifactFrom,
	citations: Schema.Array(SourceReference),
	turnId: Schema.optionalKey(Turn.Id),
	itemId: Schema.optionalKey(Item.Id),
})
export type PublishArtifactRequest = typeof PublishArtifactRequest.Type

export const PublishVersionRequest = Schema.Struct({
	...PublishArtifactRequest.fields,
	expectedVersion: Version,
})
export type PublishVersionRequest = typeof PublishVersionRequest.Type

export const CaptureSourceRequest = Schema.Struct({
	commandKey: CommandKey,
	from: SourceFrom,
	title: Schema.optionalKey(Schema.String),
	reportedUrl: Schema.optionalKey(Schema.String),
	turnId: Schema.optionalKey(Turn.Id),
})
export type CaptureSourceRequest = typeof CaptureSourceRequest.Type

/** Adds references to an assistant message that is already saved. */
export const RecordCitationsRequest = Schema.Struct({
	commandKey: CommandKey,
	itemId: Item.Id,
	citations: Schema.Array(SourceReference),
})
export type RecordCitationsRequest = typeof RecordCitationsRequest.Type
