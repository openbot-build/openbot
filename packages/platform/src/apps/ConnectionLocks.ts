import { Context, Effect, Layer, RcMap, Semaphore } from "effect"
import type { Store } from "@openbot-build/protocol"

export class ConnectionLocks extends Context.Service<
	ConnectionLocks,
	{
		readonly withConnection: <A, E, R>(
			key: Store.ConnectionKey,
			operation: Effect.Effect<A, E, R>,
		) => Effect.Effect<A, E, R>
	}
>()("@openbot-build/platform/apps/ConnectionLocks") {}

export const layer = Layer.effect(
	ConnectionLocks,
	Effect.gen(function* () {
		const locks = yield* RcMap.make({
			lookup: (_key: string) => Semaphore.make(1),
		})
		return ConnectionLocks.of({
			withConnection: (key, operation) =>
				Effect.scoped(
					Effect.gen(function* () {
						const semaphore = yield* RcMap.get(
							locks,
							JSON.stringify([key.owner, key.connectionId]),
						)
						return yield* semaphore.withPermits(1)(operation)
					}),
				),
		})
	}),
)
