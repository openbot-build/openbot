import { Item, Plugin } from "@openbot-build/core"
import { Memory as Api } from "@openbot-build/api"
import { Context, Data, Schema } from "effect"
import type { Effect } from "effect"
import type { LanguageModel } from "effect/ai"

/** The schemas are part of the HTTP contract, so they live in the api package. */
export const Kind = Api.Kind
export type Kind = Api.Kind
export const EntryStatus = Api.EntryStatus
export type EntryStatus = Api.EntryStatus
export const Entry = Api.Entry
export type Entry = Api.Entry
export const State = Api.State
export type State = Api.State
/** The plugin id. It is also the key of the memory store in the Timeline. */
export const storeKey = "@openbot-build/openbot/memory"
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
export const Edit = Api.Edit
export type Edit = Api.Edit
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
>()("@openbot-build/openbot/memory/Memory/MemoryModel") {}

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
>()("@openbot-build/openbot/memory/Memory/MemoryPolicy") {}

export const Settings = Api.Settings
export type Settings = Api.Settings

export interface Options {
	readonly model?: typeof MemoryModel.Service
	readonly policy?: typeof MemoryPolicy.Service
}
