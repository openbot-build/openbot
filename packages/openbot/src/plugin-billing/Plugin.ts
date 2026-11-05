/** The billing plugin: the wallets of organizations, usage and budgets. */
import { PgClient } from "@effect/sql-pg"
import { AuditLog } from "@openbot-build/identity-contract/audit/AuditLog"
import { Organization } from "@openbot-build/identity-contract/organization/Organization"
import { Billing } from "@openbot-build/server-billing/billing/Billing"
import * as Wallets from "@openbot-build/server-billing/billing/Host"
import { Settings } from "@openbot-build/server-kernel/settings/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
import * as HttpMounts from "./HttpMounts.ts"

export const id = "billing"

/** The keys that this plugin publishes. */
export const publishes = [Wallets.Wallets] as const

export default Feature.make("@openbot-build/plugin-billing")
	.stage({
		inject: [Organization, Billing, PgClient.PgClient, Settings],
		services: Wallets.layer,
		publishes,
	})
	.start({
		inject: [...HttpMounts.inject, AuditLog],
		layer: HttpMounts.layer,
	})
