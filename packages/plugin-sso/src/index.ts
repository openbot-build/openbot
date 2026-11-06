/** The single sign-on plugin: the sign-in connections of organizations. */
import { PgClient } from "@effect/sql-pg"
import { SecureRandom } from "effect/crypto"
import { Access } from "@openbot-build/identity-contract/access/Access"
import { AuditLog } from "@openbot-build/identity-contract/audit/AuditLog"
import { Sso } from "@openbot-build/identity-contract/sso/Sso"
import { DomainControl } from "@openbot-build/server-kernel/DomainControl"
import { Records } from "@openbot-build/server-kernel/Records"
import { Secrets } from "@openbot-build/server-kernel/Secrets"
import { Settings } from "@openbot-build/server-kernel/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
import * as HttpMounts from "./HttpMounts.ts"
import * as SsoPostgres from "./SsoPostgres.ts"

/** The keys that this plugin publishes. */
const publishes = [Sso] as const

export default Feature.make("@openbot-build/plugin-sso")
	.stage({
		inject: [
			Access,
			DomainControl,
			PgClient.PgClient,
			Records,
			Secrets,
			SecureRandom.SecureRandom,
			Settings,
		],
		services: SsoPostgres.layer,
		publishes,
	})
	.start({
		inject: [...HttpMounts.inject, AuditLog],
		layer: HttpMounts.layer,
	})
