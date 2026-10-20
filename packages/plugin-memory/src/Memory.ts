import { Item } from "@openbot-build/core"
import { Plugin } from "@openbot-build/core"
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
export const Entry = Schema.Struct({
	key: Schema.NonEmptyString,
	content: Schema.NonEmptyString,
	kind: Kind,
	sources: Schema.Array(Item.Id),
	updatedAt: Schema.Finite,
	status: Schema.Literals(["active", "retracted"]),
})
export type Entry = typeof Entry.Type
export const State = Schema.Struct({
	entries: Schema.Record(Schema.String, Entry),
	processed: Schema.Array(Item.Id),
})
export type State = typeof State.Type
export const pluginId = Schema.Literal("@openbot-build/plugin-memory")
	.pipe(Schema.brand("@openbot-build/core/PluginId"))
	.make("@openbot-build/plugin-memory")
export const store = {
	scope: "memory",
	schema: Schema.toCodecJson(State),
} satisfies Plugin.StoreDefinition<
	ReturnType<typeof Schema.toCodecJson<typeof State>>
>
export const stores = { "@openbot-build/plugin-memory": store }
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
	status: Schema.Literals(["active", "retracted"]),
})
export type Change = typeof Change.Type
export const Extraction = Schema.Struct({ changes: Schema.Array(Change) })
export const Command = Schema.TaggedUnion({
	Remember: {
		key: Schema.NonEmptyString,
		content: Schema.NonEmptyString,
		kind: Kind,
	},
	Forget: { key: Schema.NonEmptyString },
	Configure: {
		use: Schema.Boolean,
		generate: Schema.Boolean,
	},
	Refresh: {},
})
export type Command = typeof Command.Type
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

export interface Options {
	readonly model?: typeof MemoryModel.Service
	readonly policy?: typeof MemoryPolicy.Service
}
