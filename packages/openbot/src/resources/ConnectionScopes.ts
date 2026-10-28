import { App } from "@openbot-build/protocol"
import { Crypto, Effect, Exit, Layer, Schema, Scope, Stream } from "effect"
import * as Background from "../execution/Background.ts"
import { Transport } from "./Transport.ts"

const keyCodec = Schema.fromJsonString(
	Schema.Tuple([Schema.String, Schema.String]),
)

/** Each physical App scope has a lease. A connection can have scopes on many nodes. */
const make = (kind: string) =>
	Effect.gen(function* () {
		const background = yield* Background.make
		const transport = yield* Transport
		const crypto = yield* Crypto.Crypto
		const owner = yield* Scope.Scope
		const group = (key: {
			readonly owner: string
			readonly connectionId: string
		}) =>
			Schema.encodeEffect(keyCodec)([key.owner, key.connectionId]).pipe(
				Effect.orDie,
				Effect.map((namespace) => ({ namespace, kind })),
			)
		return App.ConnectionScopes.of({
			register: ({ key, scope }) =>
				Effect.gen(function* () {
					const release = yield* Effect.cached(Scope.close(scope, Exit.void))
					const resource = {
						...(yield* group(key)),
						id: yield* crypto.randomUUIDv7().pipe(Effect.orDie),
					}
					const held = yield* transport
						.register(resource, () => Stream.empty, { release })
						.pipe(Scope.provide(owner), Effect.orDie)
					// A caller can outlive this server scope. Reuse the full close result then.
					const close = yield* Effect.cached(
						held.retire.pipe(Effect.ensuring(release), Effect.orDie),
					)
					yield* held.lost.pipe(
						Effect.andThen(close),
						background.logFailure("An App connection scope could not close."),
						Effect.forkIn(owner),
					)
					return { close }
				}),
			close: (key) =>
				group(key).pipe(Effect.flatMap(transport.release), Effect.orDie),
		})
	})

export const layer = Layer.effect(App.ConnectionScopes, make("app-connection"))
export const layerDeveloper = Layer.effect(
	App.ConnectionScopes,
	make("developer-connection"),
)
