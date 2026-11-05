import { PgClient } from "@effect/sql-pg"
import * as Migrations from "@openbot-build/server-upgrade/Migrations"
import * as DatabaseCheck from "@openbot-build/server-kernel/database/Check"
import { type Redacted } from "effect"

export const layer = (options: {
	readonly databaseUrl: Redacted.Redacted<string>
}) => PgClient.layer({ url: options.databaseUrl })
export const migrate = Migrations.initialize
export const check = DatabaseCheck.check
export const checkStartup = DatabaseCheck.checkStartup
