/** The audit plugin: the audit log of each organization. */
import { PgClient } from "@effect/sql-pg"
import { AuditLog } from "@openbot-build/identity-contract/audit/AuditLog"
import * as Feature from "@openbot-build/server-plugin/Feature"
import * as AuditLogPostgres from "./AuditLogPostgres.ts"

/** The keys that this plugin publishes. */
const publishes = [AuditLog] as const

export default Feature.make("@openbot-build/plugin-audit")
	.stage({
		inject: [PgClient.PgClient],
		services: AuditLogPostgres.layer,
		publishes,
	})
	.done()
