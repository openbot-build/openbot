import { Effect, Layer } from "effect"
import * as EnvironmentConfiguration from "../configuration/EnvironmentConfiguration.ts"
import * as SecretFiles from "../configuration/SecretFiles.ts"
import { NodeRuntime } from "@effect/platform-node"

import * as Server from "./Server.ts"
import * as ErrorReporting from "./ErrorReporting.ts"
import { FetchHttpClient } from "effect/http"

NodeRuntime.runMain(
	ErrorReporting.withStartup(
		Effect.gen(function* () {
			const settings = yield* EnvironmentConfiguration.load
			return yield* Layer.launch(
				Server.layer(settings).pipe(Layer.provide(FetchHttpClient.layer)),
			)
		}),
	).pipe(
		// This program owns the whole application Layer scope.
		// @effect-diagnostics-next-line strictEffectProvide:off
		Effect.provide(SecretFiles.layer()),
	),
)
