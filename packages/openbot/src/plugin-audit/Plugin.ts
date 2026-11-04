/** The audit plugin: the audit log of each organization. */
import { PgClient } from "@effect/sql-pg"
import { AuditLog } from "../identity-contract/audit/AuditLog.ts"
import * as Feature from "../server-plugin/Feature.ts"
import * as AuditLogPostgres from "./AuditLogPostgres.ts"

export const id = "audit"

/** The keys that this plugin publishes. */
export const publishes = [AuditLog] as const

export default Feature.make("@openbot-build/plugin-audit")
	.stage({
		inject: [PgClient.PgClient],
		services: AuditLogPostgres.layer,
		publishes,
	})
	.done()
