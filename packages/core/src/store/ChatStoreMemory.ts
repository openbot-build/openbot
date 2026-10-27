import { Context, Effect, Layer, type Scope } from "effect"
import { dual } from "effect/Function"
import type * as ChatStore from "./ChatStore.ts"
import type * as Plugin from "../plugins/Plugin.ts"
import * as MemoryPersistence from "./MemoryPersistence.ts"
import * as ChatStoreRepository from "./ChatStoreRepository.ts"

type Construction<S extends Plugin.Stores> = Effect.Effect<
	ChatStore.Store<ChatStore.Plugins<S>>,
	never,
	Scope.Scope | ChatStore.DecodingServices<S> | ChatStore.EncodingServices<S>
>
export const make = <S extends Plugin.Stores>(
	definition: ChatStore.Definition<S>,
): Construction<S> =>
	Effect.flatMap(MemoryPersistence.make, (persistence) =>
		ChatStoreRepository.make({ definition, persistence }),
	)

export const layer: {
	<S extends Plugin.Stores>(
		definition: ChatStore.Definition<S>,
	): <I>(
		tag: Context.Service<I, ChatStore.Store<ChatStore.Plugins<S>>>,
	) => Layer.Layer<
		I,
		never,
		ChatStore.DecodingServices<S> | ChatStore.EncodingServices<S>
	>
	<I, S extends Plugin.Stores>(
		tag: Context.Service<I, ChatStore.Store<ChatStore.Plugins<S>>>,
		definition: ChatStore.Definition<S>,
	): Layer.Layer<
		I,
		never,
		ChatStore.DecodingServices<S> | ChatStore.EncodingServices<S>
	>
} = dual(
	2,
	<I, S extends Plugin.Stores>(
		tag: Context.Service<I, ChatStore.Store<ChatStore.Plugins<S>>>,
		definition: ChatStore.Definition<S>,
	) => Layer.effect(tag, make(definition)),
)
