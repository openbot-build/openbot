import { Context, Data, Schema } from "effect"
import type { Effect } from "effect"
import type { Index as ProtocolIndex, Indexing } from "@openbot-build/protocol"

export const Id = Schema.String.pipe(
	Schema.brand("@openbot-build/app-host/IndexId"),
)
export type Id = typeof Id.Type

export class Source extends Data.TaggedClass("Index.Source")<{
	readonly id: Id
	readonly name: string
	readonly url: string
}> {}

export class SearchResult extends Data.TaggedClass("Index.SearchResult")<{
	readonly index: Id
	readonly entry: ProtocolIndex.Entry
}> {}

export class IndexError extends Data.TaggedError("IndexError")<{
	readonly reason: "source-not-found" | "unavailable" | "configuration-failed"
	readonly message: string
}> {}

/** Discovery and public sync never receive user connections or credentials. */
export class Index extends Context.Service<
	Index,
	{
		readonly add: (source: Source) => Effect.Effect<Source, IndexError>
		readonly remove: (index: Id) => Effect.Effect<void, IndexError>
		readonly list: Effect.Effect<ReadonlyArray<Source>, IndexError>
		readonly search: (input: {
			readonly index?: Id
			readonly query: string
		}) => Effect.Effect<ReadonlyArray<SearchResult>, IndexError>
		readonly sync: (
			input: Indexing.Input,
		) => Effect.Effect<
			Indexing.SyncResult,
			Indexing.IndexingError | ProtocolIndex.IndexError
		>
	}
>()("@openbot-build/app-host/Index") {}
