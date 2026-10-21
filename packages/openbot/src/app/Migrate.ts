import { Config, Effect, Layer } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import * as SecretFiles from "../configuration/SecretFiles.ts"
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
			).pipe(
				// The database URL may come from a secret file.
				Layer.provide(Layer.merge(NodeServices.layer, SecretFiles.layer())),
			),
		),
	),
)
