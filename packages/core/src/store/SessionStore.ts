import {
	Context,
	Data,
	Schema,
	type Effect,
	type Option,
	type Stream,
	type SchemaIssue,
	type JsonPatch,
} from "effect"
import * as Session from "../session/Session.ts"
import * as Memory from "../memory/Memory.ts"
import * as Item from "../memory/Item.ts"
import type * as Turn from "../session/Turn.ts"
import type * as Plugin from "../plugins/Plugin.ts"

export const Content = Schema.Struct({
	id: Schema.String,
	message: Item.Id,
	content: Schema.Json,
})
export type Content = typeof Content.Type
export const Snapshot = Schema.Struct({
	...Memory.Version.fields,
	snapshotFormatVersion: Schema.Literal(2),
	value: Schema.JsonObject,
	history: Schema.Array(
		Schema.Struct({ message: Item.Id, content: Schema.String }),
	),
})
export type Snapshot = typeof Snapshot.Type
export const Record = Schema.Struct({
	formatVersion: Schema.Literal(3),
	session: Session.Ref,
	versions: Schema.Array(Snapshot),
	messages: Schema.Array(Content),
})
export type Record = typeof Record.Type
export interface Delta {
	readonly session: Session.Ref
	readonly expected: Session.Ref | null
	readonly versions: ReadonlyArray<Snapshot>
	readonly messages: ReadonlyArray<Content>
}
export interface Persistence {
	readonly getRef: (
		session: Session.Id,
	) => Effect.Effect<Session.Ref | null, SessionStoreError>
	readonly listRefs: (input?: {
		readonly archived?: boolean
	}) => Effect.Effect<ReadonlyArray<Session.Ref>, SessionStoreError>
	readonly headers: (
		ids: ReadonlyArray<Memory.VersionId>,
	) => Effect.Effect<ReadonlyArray<Memory.Version>, SessionStoreError>
	readonly snapshot: (
		id: Memory.VersionId,
	) => Effect.Effect<Snapshot | null, SessionStoreError>
	readonly contentHeaders: (
		ids: ReadonlyArray<string>,
	) => Effect.Effect<
		ReadonlyArray<Pick<Content, "id" | "message">>,
		SessionStoreError
	>
	readonly contents: (
		ids: ReadonlyArray<string>,
	) => Effect.Effect<ReadonlyArray<Content>, SessionStoreError>
	readonly save: (input: Delta) => Effect.Effect<void, SessionStoreError>
	readonly remove: (ref: Session.Ref) => Effect.Effect<void, SessionStoreError>
}
export type Plugins<S extends Plugin.Stores> = {
	readonly [K in keyof S]?: S[K]["schema"]["Type"]
}
export type DecodingServices<S extends Plugin.Stores> =
	S[keyof S]["schema"]["DecodingServices"]
export type EncodingServices<S extends Plugin.Stores> =
	S[keyof S]["schema"]["EncodingServices"]
export class SessionStoreError extends Data.TaggedError("SessionStoreError")<{
	readonly reason:
		| "encode-failed"
		| "invalid-json"
		| "decode-failed"
		| "unsupported-format"
		| "reference-invalid"
		| "parent-missing"
		| "version-cycle"
		| "version-unreachable"
		| "diff-invalid"
		| "version-conflict"
		| "message-conflict"
		| "message-missing"
		| "reference-conflict"
		| "storage-failed"
	readonly message: string
	readonly issue?: SchemaIssue.Issue
	readonly session?: Session.Id
	readonly version?: Memory.VersionId
}> {}
export interface Definition<
	S extends Plugin.Stores,
	V extends string = string,
> {
	readonly schemaVersion: V
	readonly stores: S
	readonly schema: Schema.Codec<
		Memory.Value<Plugins<S>>,
		Schema.Json,
		DecodingServices<S>,
		EncodingServices<S>
	>
	readonly sessionSchema: Schema.Codec<
		Session.Ref,
		Schema.Json,
		DecodingServices<S>,
		EncodingServices<S>
	>
}
export interface DefinitionFactory {
	readonly define: <
		const S extends Plugin.Stores,
		const V extends string,
	>(input: {
		readonly stores: S & {
			readonly memory?: never
			readonly session?: never
		}
		readonly schemaVersion: V & (string extends V ? never : unknown)
	}) => Effect.Effect<Definition<S, V>>
}
export interface Serialization<S extends Plugin.Stores> {
	readonly encode: (input: {
		readonly definition: Definition<S>
		readonly record: Record
	}) => Effect.Effect<
		string,
		SessionStoreError,
		DecodingServices<S> | EncodingServices<S>
	>
	readonly decode: (input: {
		readonly definition: Definition<S>
		readonly input: string
	}) => Effect.Effect<
		Record,
		SessionStoreError,
		DecodingServices<S> | EncodingServices<S>
	>
	readonly materialize: (input: {
		readonly definition: Definition<S>
		readonly record: Record
		readonly version?: Memory.VersionId
	}) => Effect.Effect<
		Memory.State<Plugins<S>>,
		SessionStoreError,
		DecodingServices<S> | EncodingServices<S>
	>
	readonly compare: (input: {
		readonly definition: Definition<S>
		readonly record: Record
		readonly base: Memory.VersionId
		readonly target: Memory.Value<Plugins<S>>
	}) => Effect.Effect<
		JsonPatch.JsonPatch,
		SessionStoreError,
		DecodingServices<S> | EncodingServices<S>
	>
}
export type Change<P = {}> = Data.TaggedEnum<{
	VersionCommitted: {
		readonly previous: Session.Ref | null
		readonly view: Session.View<P>
	}
	RefUpdated: {
		readonly previous: Session.Ref | null
		readonly ref: Session.Ref
	}
	RefRemoved: { readonly ref: Session.Ref }
}>
export interface Mutation<P> {
	readonly value?: Memory.Value<P>
	readonly session?: Partial<
		Pick<
			Session.Ref,
			| "metadata"
			| "settings"
			| "pending"
			| "turns"
			| "inheritedTurns"
			| "business"
		>
	>
}
export interface Store<P = {}> {
	readonly get: (
		session: Session.Id,
	) => Effect.Effect<Option.Option<Session.Ref>, SessionStoreError>
	readonly list: (input?: {
		readonly archived?: boolean
	}) => Effect.Effect<ReadonlyArray<Session.Ref>, SessionStoreError>
	readonly read: {
		(
			session: Session.Id,
		): Effect.Effect<
			Session.View<P>,
			Session.SessionNotFound | SessionStoreError
		>
		(
			session: Session.Id,
			version: Memory.VersionId,
		): Effect.Effect<
			Memory.State<P>,
			Session.SessionNotFound | Memory.VersionError | SessionStoreError
		>
	}
	readonly getVersion: (
		version: Memory.VersionId,
	) => Effect.Effect<Option.Option<Memory.Version>, SessionStoreError>
	readonly readVersion: (
		version: Memory.VersionId,
	) => Effect.Effect<Memory.State<P>, Memory.VersionError | SessionStoreError>
	readonly create: (input: {
		readonly metadata: Session.MetadataInput
		readonly value?: Memory.Value<P>
		readonly settings?: Partial<Turn.Settings>
		readonly business?: Session.Ref["business"]
	}) => Effect.Effect<Session.View<P>, SessionStoreError>
	readonly commit: (input: {
		readonly expected: Session.Ref
		readonly value: Memory.Value<P>
	}) => Effect.Effect<
		Session.View<P>,
		Session.SessionNotFound | SessionStoreError
	>
	readonly modifyEffect: <A, E, R>(input: {
		readonly session: Session.Id
		readonly expectedRevision?: Session.Revision
		readonly expectedHead?: Memory.VersionId
		readonly update: (
			current: Session.View<P>,
		) => Effect.Effect<readonly [A, Option.Option<Mutation<P>>], E, R>
	}) => Effect.Effect<
		{ readonly result: A; readonly view: Session.View<P> },
		Session.SessionNotFound | SessionStoreError | E,
		R
	>
	readonly fork: (input: {
		readonly source: Session.Id
		readonly version?: Memory.VersionId
		readonly metadata?: Session.MetadataInput
		readonly settings?: Partial<Turn.Settings>
	}) => Effect.Effect<
		Session.View<P>,
		Session.SessionNotFound | Memory.VersionError | SessionStoreError
	>
	readonly log: (input: {
		readonly from: Memory.VersionId
	}) => Effect.Effect<
		ReadonlyArray<Memory.Version>,
		Memory.VersionError | SessionStoreError
	>
	readonly diff: (input: {
		readonly base: Memory.VersionId | null
		readonly target: Memory.VersionId
	}) => Effect.Effect<
		JsonPatch.JsonPatch,
		Memory.VersionError | SessionStoreError
	>
	readonly updateMetadata: (input: {
		readonly expected: Session.Ref
		readonly metadata: Session.Metadata
	}) => Effect.Effect<Session.Ref, Session.SessionNotFound | SessionStoreError>
	readonly updateSettings: (input: {
		readonly expected: Session.Ref
		readonly settings: Turn.Settings
	}) => Effect.Effect<
		Session.View<P>,
		Session.SessionNotFound | SessionStoreError
	>
	readonly remove: (
		expected: Session.Ref,
	) => Effect.Effect<void, SessionStoreError>
	readonly import: (input: {
		readonly record: Record
		readonly expected: Session.Ref | null
	}) => Effect.Effect<Session.View<P>, SessionStoreError>
	readonly export: (
		session: Session.Id,
	) => Effect.Effect<Record, Session.SessionNotFound | SessionStoreError>
	readonly changes: (input?: {
		readonly session?: Session.Id
	}) => Stream.Stream<Change<P>>
}
export interface Options<S extends Plugin.Stores> {
	readonly definition: Definition<S>
	readonly persistence: Persistence
	readonly onCommit?: (input: {
		readonly delta: Delta
		readonly view?: Session.View<Plugins<S>>
	}) => Effect.Effect<void, SessionStoreError>
	readonly onRemove?: (
		expected: Session.Ref,
	) => Effect.Effect<void, SessionStoreError>
}
export class SessionStore extends Context.Service<SessionStore, Store>()(
	"@openbot-build/core/store/SessionStore",
) {}
