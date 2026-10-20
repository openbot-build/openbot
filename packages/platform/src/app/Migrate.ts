import { Config, Effect, Layer } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import * as DatabasePostgres from "../database/DatabasePostgres.ts"

NodeRuntime.runMain(
	DatabasePostgres.migrate.pipe(
		// This program owns the whole application Layer scope.
		// @effect-diagnostics-next-line strictEffectProvide:off
		Effect.provide(
			Layer.unwrap(
				Effect.map(Config.Redacted("OPENBOT_DATABASE_URL"), (databaseUrl) =>
					DatabasePostgres.layer({ databaseUrl }),
				),
			).pipe(Layer.provide(NodeServices.layer)),
		),
	),
)
