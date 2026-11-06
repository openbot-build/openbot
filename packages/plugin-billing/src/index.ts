/** The billing plugin: the usage and the budgets of organizations. */
import { PgClient } from "@effect/sql-pg"
import { AuditLog } from "@openbot-build/identity-contract/audit/AuditLog"
import { Organization } from "@openbot-build/identity-contract/organization/Organization"
import { Billing } from "@openbot-build/server-billing/Billing"
import { Settings } from "@openbot-build/server-kernel/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
import * as HttpMounts from "./HttpMounts.ts"

export default Feature.make("@openbot-build/plugin-billing").start({
	inject: [
		...HttpMounts.inject,
		AuditLog,
		Organization,
		Billing,
		PgClient.PgClient,
		Settings,
	],
	layer: HttpMounts.layer,
})
