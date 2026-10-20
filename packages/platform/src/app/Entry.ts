// @effect-diagnostics strictEffectProvide:off
import { Effect, Layer, Option } from "effect"
import { FetchHttpClient } from "effect/http"
import * as LarkConfiguration from "../configuration/LarkConfiguration.ts"
import * as ErrorReporting from "./ErrorReporting.ts"
import * as Lark from "./Lark.ts"

/** Set up reporting before the application configuration and the server are built. */
export const withErrorReporting = <A, E, R>(program: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const settings = yield* LarkConfiguration.load
		const layer = Option.match(settings, {
			onNone: () => Layer.empty,
			onSome: (settings) =>
				Lark.layer(settings).pipe(Layer.provide(FetchHttpClient.layer)),
		})
		return yield* program.pipe(
			ErrorReporting.withStartup,
			Effect.provide(layer),
		)
	})
