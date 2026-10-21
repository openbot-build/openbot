import { Array as Arr, Effect } from "effect"
import { dual } from "effect/Function"

import type * as SessionStore from "./SessionStore.ts"

export const batches: {
	<K, A>(
		read: (
			ids: ReadonlyArray<K>,
		) => Effect.Effect<ReadonlyArray<A>, SessionStore.SessionStoreError>,
	): (
		ids: ReadonlyArray<K>,
	) => Effect.Effect<Array<A>, SessionStore.SessionStoreError>
	<K, A>(
		ids: ReadonlyArray<K>,
		read: (
			ids: ReadonlyArray<K>,
		) => Effect.Effect<ReadonlyArray<A>, SessionStore.SessionStoreError>,
	): Effect.Effect<Array<A>, SessionStore.SessionStoreError>
} = dual(
	2,
	<K, A>(
		ids: ReadonlyArray<K>,
		read: (
			ids: ReadonlyArray<K>,
		) => Effect.Effect<ReadonlyArray<A>, SessionStore.SessionStoreError>,
	) =>
		Effect.forEach(Arr.chunksOf(ids, 200), read).pipe(
			Effect.map((batches) => batches.flat()),
		),
)
