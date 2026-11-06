/** The platform plugin: the platform admins and the settings of the platform. */
import { PgClient } from "@effect/sql-pg"
import { Access } from "@openbot-build/identity-contract/access/Access"
import { AuditLog } from "@openbot-build/identity-contract/audit/AuditLog"
import { Mail } from "@openbot-build/identity-contract/mail/Mail"
import { Organization } from "@openbot-build/identity-contract/organization/Organization"
import { PlatformAdmins } from "@openbot-build/identity-contract/platform/PlatformAdmins"
import { ModelProviders } from "@openbot-build/models-contract/ModelProviders"
import { Models } from "@openbot-build/models-contract/Models"
import { ProviderOAuth } from "@openbot-build/models-contract/ProviderOAuth"
import { Billing } from "@openbot-build/server-billing/Billing"
import { Secrets } from "@openbot-build/server-kernel/Secrets"
import { Settings } from "@openbot-build/server-kernel/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
import * as HttpMounts from "./HttpMounts.ts"
import * as PlatformAdminsPostgres from "./PlatformAdminsPostgres.ts"

/** The keys that this plugin publishes. */
const publishes = [PlatformAdmins] as const

export default Feature.make("@openbot-build/plugin-platform")
	.stage({
		inject: [PgClient.PgClient],
		services: PlatformAdminsPostgres.layer,
		publishes,
	})
	.start({
		inject: [
			...HttpMounts.inject,
			Access,
			AuditLog,
			Billing,
			Mail,
			ModelProviders,
			Models,
			Organization,
			ProviderOAuth,
			Secrets,
			Settings,
		],
		layer: HttpMounts.layer,
	})
