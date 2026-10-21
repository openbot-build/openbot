import { Item, Plugin } from "@openbot-build/core"
import { Context, Data, Schema } from "effect"
import type { Effect } from "effect"
import type { LanguageModel } from "effect/ai"

export const Kind = Schema.Literals([
	"fact",
	"decision",
	"preference",
	"procedure",
	"hypothesis",
])
/** A `retracted` entry is kept, so later runs do not learn it again. */
export const EntryStatus = Schema.Literals(["active", "retracted"])
export type EntryStatus = typeof EntryStatus.Type
export const Entry = Schema.Struct({
	key: Schema.NonEmptyString,
	content: Schema.NonEmptyString,
	kind: Kind,
	sources: Schema.Array(Item.Id),
	updatedAt: Schema.Finite,
	status: EntryStatus,
})
export type Entry = typeof Entry.Type
export const State = Schema.Struct({
	entries: Schema.Record(Schema.String, Entry),
	processed: Schema.Array(Item.Id),
})
export type State = typeof State.Type
/** The plugin id. It is also the key of the memory store in the Timeline. */
export const storeKey = "@openbot-build/plugin-memory"
export const pluginId = Schema.Literal(storeKey)
	.pipe(Schema.brand("@openbot-build/core/PluginId"))
	.make(storeKey)
export const store = {
	scope: "timeline",
	schema: Schema.toCodecJson(State),
} satisfies Plugin.StoreDefinition<
	ReturnType<typeof Schema.toCodecJson<typeof State>>
>
export const stores = { [storeKey]: store }
export type States = typeof stores
export type Values = { readonly [K in keyof States]?: State }
export const empty = (): State => ({
	entries: {},
	processed: [],
})

export const Change = Schema.Struct({
	key: Schema.NonEmptyString,
	content: Schema.NonEmptyString,
	kind: Kind,
	sources: Schema.Array(Item.Id).check(Schema.isMinLength(1)),
	status: EntryStatus,
})
export type Change = typeof Change.Type
export const Extraction = Schema.Struct({ changes: Schema.Array(Change) })
/** A direct edit of one entry. */
export const Edit = Schema.TaggedUnion({
	Remember: {
		key: Schema.NonEmptyString,
		content: Schema.NonEmptyString,
		kind: Kind,
	},
	Forget: { key: Schema.NonEmptyString },
})
export type Edit = typeof Edit.Type
export class MemoryError extends Data.TaggedError("MemoryError")<{
	readonly reason: "model-failed" | "invalid-change" | "stale-input"
	readonly message: string
}> {}

export interface ExtractionInput {
	readonly state: State
	readonly history: ReadonlyArray<Item.Record>
}
/** @effect-expect-leaking LanguageModel */
export class MemoryModel extends Context.Service<
	MemoryModel,
	{
		readonly extract: (
			input: ExtractionInput,
		) => Effect.Effect<
			typeof Extraction.Type,
			MemoryError,
			LanguageModel.LanguageModel
		>
	}
>()("@openbot-build/plugin-memory/Memory/MemoryModel") {}

export class MemoryPolicy extends Context.Service<
	MemoryPolicy,
	{
		readonly apply: (
			input: ExtractionInput & {
				readonly changes: ReadonlyArray<Change>
				readonly now: number
			},
		) => Effect.Effect<State, MemoryError>
		readonly project: (state: State) => string
	}
>()("@openbot-build/plugin-memory/Memory/MemoryPolicy") {}

/** The memory switches for one Turn. The host decides their values. */
export const Settings = Schema.Struct({
	/** Add the active entries to the model instructions. */
	use: Schema.Boolean,
	/** Learn new entries after the Turn completes. */
	generate: Schema.Boolean,
})
export type Settings = typeof Settings.Type

export interface Options {
	readonly model?: typeof MemoryModel.Service
	readonly policy?: typeof MemoryPolicy.Service
}
