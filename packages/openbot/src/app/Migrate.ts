import { Config, Effect, Layer } from "effect"
import { Command } from "effect/cli"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import * as SecretFiles from "../configuration/SecretFiles.ts"
import * as DatabasePostgres from "../database/DatabasePostgres.ts"

const migrate = DatabasePostgres.migrate.pipe(
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
)

const command = Command.make("openbot migrate").pipe(
	Command.withDescription(
		[
			"Bring the database schema up to date.",
			"Set OPENBOT_DATABASE_URL to the address of the Postgres database.",
			"It can also come from the file /run/secrets/OPENBOT_DATABASE_URL.",
			// Effect CLI indents only the first line of a description, so the other lines get the indent here.
		].join("\n  "),
	),
	Command.withHandler(() => migrate),
)

NodeRuntime.runMain(
	Command.run(command, { version: "0.1.0" }).pipe(
		// This program owns the whole application Layer scope.
		// @effect-diagnostics-next-line strictEffectProvide:off
		Effect.provide(NodeServices.layer),
	),
)
