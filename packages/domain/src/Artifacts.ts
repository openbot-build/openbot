import { Chat, Item, Turn } from "@openbot-build/core"
import { Schema } from "effect"
import { FileObject } from "./Files.ts"

export const ArtifactId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/domain/ArtifactId"))
export type ArtifactId = typeof ArtifactId.Type

export const SourceId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/domain/SourceId"))
export type SourceId = typeof SourceId.Type

export const Version = Schema.Int.check(Schema.isGreaterThan(0))
export const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const Availability = Schema.Literals(["ready", "unavailable"])

/** A reference to saved material, not a claim that its facts are true. */
export const SourceReference = Schema.Struct({
	type: Schema.Literal("source_reference"),
	source_id: SourceId,
	quote: Schema.optionalKey(Schema.NonEmptyString),
})
export type SourceReference = typeof SourceReference.Type

/** The bytes of each version stay fixed. Availability can change after a delete. */
export const ArtifactVersion = Schema.Struct({
	artifactId: ArtifactId,
	version: Version,
	chatId: Chat.Id,
	turnId: Schema.NullOr(Turn.Id),
	itemId: Schema.NullOr(Item.Id),
	file: FileObject,
	sha256: Digest,
	citations: Schema.Array(SourceReference),
	availability: Availability,
	createdAt: Schema.Finite,
})
export type ArtifactVersion = typeof ArtifactVersion.Type

/** One piece of work keeps its ID when a new version is made. */
export const Artifact = Schema.Struct({
	id: ArtifactId,
	chatId: Chat.Id,
	title: Schema.String,
	latestVersion: Version,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
})
export type Artifact = typeof Artifact.Type

export const SourceFrom = Schema.TaggedUnion({
	PublicUrl: { url: Schema.NonEmptyString },
	AppResult: { operationId: Schema.NonEmptyString },
	ComputerTextFile: {
		computerId: Schema.NonEmptyString,
		path: Schema.NonEmptyString,
	},
})
export type SourceFrom = typeof SourceFrom.Type

/** Only PublicUrl records an address that OpenBot itself read. */
export const SourceOrigin = Schema.TaggedUnion({
	PublicUrl: {
		url: Schema.NonEmptyString,
		finalUrl: Schema.NonEmptyString,
	},
	AppResult: { operationId: Schema.NonEmptyString },
	ComputerTextFile: {
		computerId: Schema.NonEmptyString,
		path: Schema.NonEmptyString,
	},
})
export type SourceOrigin = typeof SourceOrigin.Type

/** A saved, fixed copy of material that a Chat may cite. */
export const Source = Schema.Struct({
	id: SourceId,
	chatId: Chat.Id,
	turnId: Schema.NullOr(Turn.Id),
	title: Schema.String,
	reportedUrl: Schema.optionalKey(Schema.String),
	origin: SourceOrigin,
	file: FileObject,
	sha256: Digest,
	availability: Availability,
	capturedAt: Schema.Finite,
})
export type Source = typeof Source.Type

export const ArtifactFrom = Schema.TaggedUnion({
	Text: { text: Schema.String },
	ComputerPath: {
		computerId: Schema.NonEmptyString,
		path: Schema.NonEmptyString,
	},
})
export type ArtifactFrom = typeof ArtifactFrom.Type

/** Public history adds links without changing the saved model prompt. */
export const ChatItem = Schema.Struct({
	...Item.Record.fields,
	citations: Schema.Array(SourceReference),
	artifacts: Schema.Array(ArtifactVersion),
})
export type ChatItem = typeof ChatItem.Type

export class ArtifactNotFound extends Schema.TaggedError<
	ArtifactNotFound,
	{ readonly brand: unique symbol }
>()("ArtifactNotFound", { id: Schema.String }) {}
export class SourceNotFound extends Schema.TaggedError<
	SourceNotFound,
	{ readonly brand: unique symbol }
>()("SourceNotFound", { id: Schema.String }) {}
export class ArtifactConflict extends Schema.TaggedError<
	ArtifactConflict,
	{ readonly brand: unique symbol }
>()("ArtifactConflict", { message: Schema.String }) {}
export class ArtifactInvalid extends Schema.TaggedError<
	ArtifactInvalid,
	{ readonly brand: unique symbol }
>()("ArtifactInvalid", { message: Schema.String }) {}
export class ArtifactStorageUnavailable extends Schema.TaggedError<
	ArtifactStorageUnavailable,
	{ readonly brand: unique symbol }
>()("ArtifactStorageUnavailable", {}) {}
