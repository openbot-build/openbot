/** The organization plugin: organizations, their members and invitations. */
import { PgClient } from "@effect/sql-pg"
import { Authorization } from "@openbot-build/domain"
import { SecureRandom } from "effect/crypto"
import { AuditLog } from "@openbot-build/identity-contract/audit/AuditLog"
import { Roles } from "@openbot-build/identity-contract/authorization/Roles"
import { Mail } from "@openbot-build/identity-contract/mail/Mail"
import { Organization } from "@openbot-build/identity-contract/organization/Organization"
import { PlatformAdmins } from "@openbot-build/identity-contract/platform/PlatformAdmins"
import { ModelRegistry } from "@openbot-build/models-contract/models/ModelRegistry"
import { Settings } from "@openbot-build/server-kernel/settings/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
import * as HttpMounts from "./HttpMounts.ts"
import * as OrganizationPostgres from "./OrganizationPostgres.ts"

/** The keys that this plugin publishes. */
const publishes = [Organization] as const

export default Feature.make("@openbot-build/plugin-organization")
	.stage({
		inject: [AuditLog, PgClient.PgClient, SecureRandom.SecureRandom, Settings],
		services: OrganizationPostgres.layer,
		publishes,
	})
	.start({
		inject: [
			...HttpMounts.inject,
			Authorization.Auth,
			Mail,
			ModelRegistry,
			PlatformAdmins,
			Roles,
		],
		layer: HttpMounts.layer,
	})
