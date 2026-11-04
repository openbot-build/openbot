import { PgClient } from "@effect/sql-pg"
import * as StorageMigration from "./Migrations.ts"
import { type Redacted } from "effect"

export const layer = (options: {
	readonly databaseUrl: Redacted.Redacted<string>
}) => PgClient.layer({ url: options.databaseUrl })
export const migrate = StorageMigration.initialize
export const check = StorageMigration.check
export const checkStartup = StorageMigration.checkStartup
