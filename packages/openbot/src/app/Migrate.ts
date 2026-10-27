import { Array as Arr, Config, Effect, Layer } from "effect"
import { Command } from "effect/cli"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import * as SecretFiles from "../configuration/SecretFiles.ts"
import * as DatabasePostgres from "../database/DatabasePostgres.ts"
import * as DataMigration from "../database/Migrations.ts"
import * as Secrets from "../secrets/Secrets.ts"
import * as Store from "../execution/Store.ts"

const migrate = DataMigration.upgrade.pipe(
	// @effect-diagnostics-next-line strictEffectProvide:off -- This program owns the whole application Layer scope.
	Effect.provide(
		Layer.unwrap(
			Effect.map(
				Config.all({
					databaseUrl: Config.Redacted("OPENBOT_DATABASE_URL"),
					secretKeys: Config.Redacted("OPENBOT_SECRET_KEYS"),
				}),
				({ databaseUrl, secretKeys }) =>
					Store.layer.pipe(
						Layer.provideMerge(
							Layer.merge(
								DatabasePostgres.layer({ databaseUrl }),
								Secrets.layer(secretKeys),
							),
						),
					),
			),
		).pipe(
			// The database URL may come from a secret file.
			// The program gives the Node services that read the files.
			Layer.provide(SecretFiles.layer()),
		),
	),
)

const command = Command.make("openbot migrate").pipe(
	Command.withDescription(
		Arr.join(
			[
				"Bring the database schema and data up to date while all servers are stopped.",
				"Set OPENBOT_DATABASE_URL to the address of the Postgres database.",
				"Set OPENBOT_SECRET_KEYS to the keys that open the stored secrets.",
				"It can also come from the file /run/secrets/OPENBOT_DATABASE_URL.",
			],
			// Effect CLI indents only the first line of a description, so the other lines get the indent here.
			"\n  ",
		),
	),
	Command.withHandler(() => migrate),
)

NodeRuntime.runMain(
	Command.run(command, { version: "0.1.0" }).pipe(
		// @effect-diagnostics-next-line strictEffectProvide:off -- This program owns the whole application Layer scope.
		Effect.provide(NodeServices.layer),
	),
)
