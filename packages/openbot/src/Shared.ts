/**
 * The services that every part of OpenBot shares. The small programs, such as
 * `openbot setup`, use this module alone, so they do not load the plugins.
 */
import { PgClient } from "@effect/sql-pg"
import { Layer, type Redacted } from "effect"
import * as Migrations from "@openbot-build/server-database/Migrations"
import * as ErrorRecords from "@openbot-build/server-kernel/Records"
import * as Secrets from "@openbot-build/server-kernel/Secrets"
import * as SettingsPostgres from "@openbot-build/server-kernel/SettingsPostgres"

/**
 * The database pool, the secret keys, the shared settings and the error
 * records. The schema of the database is checked first.
 */
export const layer = (options: {
	readonly databaseUrl: Redacted.Redacted<string>
	readonly secretKeys: Redacted.Redacted<string>
}) =>
	SettingsPostgres.layer.pipe(
		Layer.provideMerge(ErrorRecords.layer),
		Layer.provideMerge(Secrets.layer(options.secretKeys)),
		Layer.provideMerge(
			// The schema must match before any service starts.
			Layer.effectDiscard(Migrations.check).pipe(
				Layer.provideMerge(PgClient.layer({ url: options.databaseUrl })),
			),
		),
	)

/** The services that `layer` gives. */
export type Services = Layer.Success<ReturnType<typeof layer>>
