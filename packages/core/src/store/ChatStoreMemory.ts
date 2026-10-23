import { Context, Effect, Layer, type Scope } from "effect"
import { dual } from "effect/Function"
import type * as SessionStore from "./SessionStore.ts"
import type * as Plugin from "../plugins/Plugin.ts"
import * as MemoryPersistence from "./MemoryPersistence.ts"
import * as SessionStoreRepository from "./SessionStoreRepository.ts"

type Construction<S extends Plugin.Stores> = Effect.Effect<
	SessionStore.Store<SessionStore.Plugins<S>>,
	never,
	| Scope.Scope
	| SessionStore.DecodingServices<S>
	| SessionStore.EncodingServices<S>
>
export const make = <S extends Plugin.Stores>(
	definition: SessionStore.Definition<S>,
): Construction<S> =>
	Effect.flatMap(MemoryPersistence.make, (persistence) =>
		SessionStoreRepository.make({ definition, persistence }),
	)

export const layer: {
	<S extends Plugin.Stores>(
		definition: SessionStore.Definition<S>,
	): <I>(
		tag: Context.Service<I, SessionStore.Store<SessionStore.Plugins<S>>>,
	) => Layer.Layer<
		I,
		never,
		SessionStore.DecodingServices<S> | SessionStore.EncodingServices<S>
	>
	<I, S extends Plugin.Stores>(
		tag: Context.Service<I, SessionStore.Store<SessionStore.Plugins<S>>>,
		definition: SessionStore.Definition<S>,
	): Layer.Layer<
		I,
		never,
		SessionStore.DecodingServices<S> | SessionStore.EncodingServices<S>
	>
} = dual(
	2,
	<I, S extends Plugin.Stores>(
		tag: Context.Service<I, SessionStore.Store<SessionStore.Plugins<S>>>,
		definition: SessionStore.Definition<S>,
	) => Layer.effect(tag, make(definition)),
)
