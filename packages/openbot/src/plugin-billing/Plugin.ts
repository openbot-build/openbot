/** The billing plugin: the wallets of organizations, usage and budgets. */
import { PgClient } from "@effect/sql-pg"
import { AuditLog } from "../identity-contract/audit/AuditLog.ts"
import { Organization } from "../identity-contract/organization/Organization.ts"
import { Billing } from "../server-billing/billing/Billing.ts"
import * as Wallets from "../server-billing/billing/Host.ts"
import { Settings } from "../server-kernel/settings/Settings.ts"
import * as Feature from "../server-plugin/Feature.ts"
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
