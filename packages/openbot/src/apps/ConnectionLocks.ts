import { Context, Effect, Layer, RcMap, Scope, Semaphore } from "effect"
import type { Store } from "@openbot-build/protocol"

export class ConnectionLocks extends Context.Service<
	ConnectionLocks,
	{
		readonly withConnection: <A, E, R>(
			key: Store.ConnectionKey,
			operation: Effect.Effect<A, E, R>,
		) => Effect.Effect<A, E, R>
	}
>()("@openbot-build/openbot/apps/ConnectionLocks") {}

export const layer = Layer.effect(
	ConnectionLocks,
	Effect.gen(function* () {
		// RcMap compares keys by value, so two equal pairs get the same lock.
		const locks = yield* RcMap.make({
			lookup: (_key: readonly [owner: string, connectionId: string]) =>
				Semaphore.make(1),
		})
		return ConnectionLocks.of({
			// The scope keeps the lock alive while the operation runs. Only the
			// borrow gets it, so a scoped operation keeps the scope of its caller.
			withConnection: (key, operation) =>
				Effect.scopedWith((scope) =>
					RcMap.get(locks, [key.owner, key.connectionId]).pipe(
						Scope.provide(scope),
						Effect.flatMap((semaphore) => semaphore.withPermits(1)(operation)),
					),
				),
		})
	}),
)
