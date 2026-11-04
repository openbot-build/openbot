/**
 * The services that every part of OpenBot shares. The small programs, such as
 * `openbot setup`, use this module alone, so they do not load the plugins.
 */
import { Layer, type Redacted } from "effect"
import * as ErrorRecords from "../server-kernel/errors/Records.ts"
import * as Secrets from "../server-kernel/secrets/Secrets.ts"
import * as SettingsPostgres from "../server-kernel/settings/SettingsPostgres.ts"
import * as DatabasePostgres from "./DatabasePostgres.ts"

/**
 * The database pool, the secret keys, the shared settings and the error
 * records. The data version and the maintenance lock are checked first.
 */
export const layer = (options: {
	readonly databaseUrl: Redacted.Redacted<string>
	readonly secretKeys: Redacted.Redacted<string>
}) =>
	SettingsPostgres.layer.pipe(
		Layer.provideMerge(ErrorRecords.layer),
		Layer.provideMerge(Secrets.layer(options.secretKeys)),
		Layer.provideMerge(
			// The data version and maintenance lock must pass before any service starts.
			Layer.effectDiscard(DatabasePostgres.checkStartup).pipe(
				Layer.provideMerge(DatabasePostgres.layer(options)),
			),
		),
	)

/** The services that `layer` gives. */
export type Services = Layer.Success<ReturnType<typeof layer>>
