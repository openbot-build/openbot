import { Context, type Effect, type Option, type HashMap } from "effect"
import type { AppIndexApi } from "@openbot-build/platform-api"
import type { Index } from "@openbot-build/protocol"

/** This repository holds only public entries that were checked independently. */
export class IndexRepository extends Context.Service<
	IndexRepository,
	{
		readonly list: Effect.Effect<ReadonlyArray<Index.Entry>, Index.IndexError>
		readonly checks: Effect.Effect<
			HashMap.HashMap<string, AppIndexApi.Check>,
			Index.IndexError
		>
		readonly get: (
			cardUrl: string,
		) => Effect.Effect<Option.Option<Index.Entry>, Index.IndexError>
		readonly upsert: (
			entry: Index.Entry,
		) => Effect.Effect<Index.Entry, Index.IndexError>
		readonly withdraw: (
			cardUrl: string,
		) => Effect.Effect<void, Index.IndexError>
	}
>()("@openbot-build/platform/apps/IndexRepository") {}
