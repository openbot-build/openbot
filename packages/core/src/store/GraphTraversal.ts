import { Chunk, Effect } from "effect"
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
		Effect.gen(function* () {
			let rows = Chunk.empty<A>()
			const next = (
				offset: number,
			): Effect.Effect<Array<A>, SessionStore.SessionStoreError> =>
				offset >= ids.length
					? Effect.succeed(Array.from(rows))
					: read(ids.slice(offset, offset + 200)).pipe(
							Effect.flatMap((batch) => {
								rows = Chunk.appendAll(rows, Chunk.fromIterable(batch))
								return next(offset + 200)
							}),
						)
			return yield* next(0)
		}),
)
