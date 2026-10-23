import {
	Context,
	Data,
	Schema,
	type Effect,
	type Option,
	type Stream,
	type SchemaIssue,
} from "effect"
import * as Chat from "../chat/Chat.ts"
import type * as ChatState from "../chat/ChatState.ts"
import type * as Item from "../chat/Item.ts"
import type * as Turn from "../chat/Turn.ts"
import type * as Plugin from "../plugins/Plugin.ts"

/** Which Items to read. Without a range, the log is read from the start. */
export interface ItemQuery {
	/** Only the Items of this Turn. */
	readonly turn?: Turn.Id
	/** Only Items after this place. */
	readonly after?: number
	/** Only Items before this place. */
	readonly before?: number
	readonly limit?: number
	/** `desc` reads the newest Items first. */
	readonly order?: "asc" | "desc"
}
/** Which Turns to read, oldest first. */
export interface TurnQuery {
	/** Only Turns after this Turn. */
	readonly after?: Turn.Id
	readonly limit?: number
}
/** One Item as JSON. `turn` is the Turn that made it, so a store can find Items by Turn. */
export interface StoredItem {
	readonly seq: number
	readonly id: string
	readonly turn: string | null
	readonly value: Schema.Json
}
/** One change, as JSON. Items are only added. A Turn record is added or replaced. */
export interface Delta {
	readonly chat: string
	readonly ref: Schema.Json
	/** The revision before the change, or `null` for a new Chat. */
	readonly expected: number | null
	/** The new state, when it changed. */
	readonly state?: Schema.Json
	readonly items: ReadonlyArray<StoredItem>
	readonly turn?: { readonly id: string; readonly value: Schema.Json }
}
/** Where a store keeps its data. Every value is JSON, so a database can keep it as text. */
export interface Persistence {
	readonly get: (chat: Chat.Id) => Effect.Effect<
		Option.Option<{
			readonly ref: Schema.Json
			readonly state: Schema.Json
		}>,
		ChatStoreError
	>
	readonly list: () => Effect.Effect<ReadonlyArray<Schema.Json>, ChatStoreError>
	readonly items: (
		chat: Chat.Id,
		query: ItemQuery,
	) => Effect.Effect<ReadonlyArray<Schema.Json>, ChatStoreError>
	readonly turns: (
		chat: Chat.Id,
		query: TurnQuery,
	) => Effect.Effect<ReadonlyArray<Schema.Json>, ChatStoreError>
	readonly turn: (
		chat: Chat.Id,
		turn: Turn.Id,
	) => Effect.Effect<Option.Option<Schema.Json>, ChatStoreError>
	/** Saves one change. It fails with `reference-conflict` when `expected` is old. */
	readonly save: (delta: Delta) => Effect.Effect<void, ChatStoreError>
	readonly remove: (chat: Chat.Id) => Effect.Effect<void, ChatStoreError>
}
export type Plugins<S extends Plugin.Stores> = {
	readonly [K in keyof S]?: S[K]["schema"]["Type"]
}
export type DecodingServices<S extends Plugin.Stores> =
	S[keyof S]["schema"]["DecodingServices"]
export type EncodingServices<S extends Plugin.Stores> =
	S[keyof S]["schema"]["EncodingServices"]
export class ChatStoreError extends Data.TaggedError("ChatStoreError")<{
	readonly reason:
		| "encode-failed"
		| "decode-failed"
		| "unsupported-format"
		| "reference-conflict"
		| "storage-failed"
	readonly message: string
	readonly issue?: SchemaIssue.Issue
	readonly chat?: Chat.Id
}> {}
export interface Definition<
	S extends Plugin.Stores,
	V extends string = string,
> {
	readonly schemaVersion: V
	readonly stores: S
	readonly schema: Schema.Codec<
		ChatState.Value<Plugins<S>>,
		Schema.Json,
		DecodingServices<S>,
		EncodingServices<S>
	>
	readonly recordSchema: Schema.Codec<
		Chat.Ref,
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
			readonly conversation?: never
			readonly chat?: never
		}
		readonly schemaVersion: V & (string extends V ? never : unknown)
	}) => Effect.Effect<Definition<S, V>>
}
export type Change<P = {}> = Data.TaggedEnum<{
	Committed: {
		readonly previous: Chat.Ref | null
		readonly view: Chat.View<P>
		readonly items: ReadonlyArray<Item.Record>
	}
	Removed: { readonly ref: Chat.Ref }
}>
export interface Mutation<P> {
	/** The new state. */
	readonly value?: ChatState.Value<P>
	/** Items to add to the end of the log. */
	readonly append?: ReadonlyArray<Item.Entry>
	readonly chat?: Partial<
		Pick<Chat.Ref, "settings" | "inbox" | "turn" | "business">
	>
}
export interface Store<P = {}> {
	readonly get: (
		chat: Chat.Id,
	) => Effect.Effect<Option.Option<Chat.Ref>, ChatStoreError>
	readonly list: () => Effect.Effect<ReadonlyArray<Chat.Ref>, ChatStoreError>
	readonly read: (
		chat: Chat.Id,
	) => Effect.Effect<Chat.View<P>, Chat.ChatNotFound | ChatStoreError>
	readonly create: (input: {
		readonly id?: Chat.Id
		readonly value?: ChatState.Value<P>
		readonly settings?: Partial<Turn.Settings>
		readonly business?: Chat.Ref["business"]
	}) => Effect.Effect<Chat.View<P>, ChatStoreError>
	readonly modifyEffect: <A, E, R>(input: {
		readonly chat: Chat.Id
		readonly expectedRevision?: Chat.Revision
		readonly update: (
			current: Chat.View<P>,
		) => Effect.Effect<readonly [A, Option.Option<Mutation<P>>], E, R>
	}) => Effect.Effect<
		{
			readonly result: A
			readonly view: Chat.View<P>
			readonly items: ReadonlyArray<Item.Record>
		},
		Chat.ChatNotFound | ChatStoreError | E,
		R
	>
	readonly items: (
		chat: Chat.Id,
		query?: ItemQuery,
	) => Effect.Effect<ReadonlyArray<Item.Record>, ChatStoreError>
	readonly turns: (
		chat: Chat.Id,
		query?: TurnQuery,
	) => Effect.Effect<ReadonlyArray<Turn.Record>, ChatStoreError>
	readonly turn: (
		chat: Chat.Id,
		turn: Turn.Id,
	) => Effect.Effect<Option.Option<Turn.Record>, ChatStoreError>
	readonly remove: (expected: Chat.Ref) => Effect.Effect<void, ChatStoreError>
	readonly changes: (input?: {
		readonly chat?: Chat.Id
	}) => Stream.Stream<Change<P>>
}
export interface Options<S extends Plugin.Stores> {
	readonly definition: Definition<S>
	readonly persistence: Persistence
	readonly onCommit?: (input: {
		readonly delta: Delta
		readonly view: Chat.View<Plugins<S>>
	}) => Effect.Effect<void, ChatStoreError>
	readonly onRemove?: (expected: Chat.Ref) => Effect.Effect<void, ChatStoreError>
}
export class ChatStore extends Context.Service<ChatStore, Store>()(
	"@openbot-build/core/store/ChatStore",
) {}
