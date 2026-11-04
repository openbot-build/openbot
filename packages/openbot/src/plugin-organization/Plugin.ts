/** The organization plugin: organizations, their members and invitations. */
import { PgClient } from "@effect/sql-pg"
import { Authorization } from "@openbot-build/domain"
import { SecureRandom } from "effect/crypto"
import { AuditLog } from "../identity-contract/audit/AuditLog.ts"
import { Roles } from "../identity-contract/authorization/Roles.ts"
import { Mail } from "../identity-contract/mail/Mail.ts"
import { Organization } from "../identity-contract/organization/Organization.ts"
import { PlatformAdmins } from "../identity-contract/platform/PlatformAdmins.ts"
import { ModelRegistry } from "../models-contract/models/ModelRegistry.ts"
import { Settings } from "../server-kernel/settings/Settings.ts"
import * as Feature from "../server-plugin/Feature.ts"
import * as HttpMounts from "./HttpMounts.ts"
import * as OrganizationPostgres from "./OrganizationPostgres.ts"

export const id = "organization"

/** The keys that this plugin publishes. */
export const publishes = [Organization] as const

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
