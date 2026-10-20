import { Effect, Layer } from "effect"
import * as EnvironmentConfiguration from "../configuration/EnvironmentConfiguration.ts"
import { NodeRuntime } from "@effect/platform-node"

import * as Server from "./Server.ts"
import * as Entry from "./Entry.ts"
import * as ProductionModel from "./ProductionModel.ts"
import { FetchHttpClient } from "effect/http"

NodeRuntime.runMain(
	Entry.withErrorReporting(
		Effect.gen(function* () {
			const settings = yield* EnvironmentConfiguration.load
			const model = yield* ProductionModel.load
			return yield* Layer.launch(
				Layer.unwrap(
					Effect.map(
						model === undefined ? Effect.void : ProductionModel.make(model),
						(sessions) =>
							Server.layer({
								...settings,
								...(sessions === undefined ? {} : { sessions }),
							}),
					),
				).pipe(Layer.provide(FetchHttpClient.layer)),
			)
		}),
	),
)
