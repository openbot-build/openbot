import { Effect, Layer, Option } from "effect"
import * as EnvironmentConfiguration from "../configuration/EnvironmentConfiguration.ts"
import * as SecretFiles from "../configuration/SecretFiles.ts"
import { NodeRuntime } from "@effect/platform-node"

import * as Server from "./Server.ts"
import * as ErrorReporting from "./ErrorReporting.ts"
import * as ProductionModel from "./ProductionModel.ts"
import { FetchHttpClient } from "effect/http"

NodeRuntime.runMain(
	ErrorReporting.withStartup(
		Effect.gen(function* () {
			const settings = yield* EnvironmentConfiguration.load
			const model = yield* ProductionModel.load
			return yield* Layer.launch(
				Layer.unwrap(
					Option.match(model, {
						onNone: () => Effect.succeed(Server.layer(settings)),
						onSome: (model) =>
							Effect.map(ProductionModel.make(model), (sessions) =>
								Server.layer({ ...settings, sessions }),
							),
					}),
				).pipe(Layer.provide(FetchHttpClient.layer)),
			)
		}),
	).pipe(
		// This program owns the whole application Layer scope.
		// @effect-diagnostics-next-line strictEffectProvide:off
		Effect.provide(SecretFiles.layer()),
	),
)
