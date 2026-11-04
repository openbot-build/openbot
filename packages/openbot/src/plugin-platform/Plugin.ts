/** The platform plugin: the platform admins and the settings of the platform. */
import { PgClient } from "@effect/sql-pg"
import { Access } from "../identity-contract/access/Access.ts"
import { AuditLog } from "../identity-contract/audit/AuditLog.ts"
import { Mail } from "../identity-contract/mail/Mail.ts"
import { Organization } from "../identity-contract/organization/Organization.ts"
import { PlatformAdmins } from "../identity-contract/platform/PlatformAdmins.ts"
import { ModelProviders } from "../models-contract/models/ModelProviders.ts"
import { Models } from "../models-contract/models/Models.ts"
import { ProviderOAuth } from "../models-contract/models/ProviderOAuth.ts"
import { Billing } from "../server-billing/billing/Billing.ts"
import { Secrets } from "../server-kernel/secrets/Secrets.ts"
import { Settings } from "../server-kernel/settings/Settings.ts"
import * as Feature from "../server-plugin/Feature.ts"
import * as HttpMounts from "./HttpMounts.ts"
import * as PlatformAdminsPostgres from "./PlatformAdminsPostgres.ts"

export const id = "platform"

/** The keys that this plugin publishes. */
export const publishes = [PlatformAdmins] as const

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
