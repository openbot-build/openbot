/** The single sign-on plugin: the sign-in connections of organizations. */
import { PgClient } from "@effect/sql-pg"
import { SecureRandom } from "effect/crypto"
import { Access } from "../identity-contract/access/Access.ts"
import { AuditLog } from "../identity-contract/audit/AuditLog.ts"
import { Sso } from "../identity-contract/sso/Sso.ts"
import { DomainControl } from "../server-kernel/apps/DomainControl.ts"
import { Records } from "../server-kernel/errors/Records.ts"
import { Secrets } from "../server-kernel/secrets/Secrets.ts"
import { Settings } from "../server-kernel/settings/Settings.ts"
import * as Feature from "../server-plugin/Feature.ts"
import * as HttpMounts from "./HttpMounts.ts"
import * as SsoPostgres from "./SsoPostgres.ts"

export const id = "sso"

/** The keys that this plugin publishes. */
export const publishes = [Sso] as const

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
