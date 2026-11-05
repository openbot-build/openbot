/** The access plugin: who may join the platform, and how. */
import { PgClient } from "@effect/sql-pg"
import { SecureRandom } from "effect/crypto"
import * as AccessLayer from "@openbot-build/identity-contract/access/Access"
import { Auth } from "@openbot-build/identity-contract/auth/Auth"
import { Settings } from "@openbot-build/server-kernel/settings/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
import * as HttpMounts from "./HttpMounts.ts"

/** The keys that this plugin publishes. */
const publishes = [AccessLayer.Access] as const

export default Feature.make("@openbot-build/plugin-access")
	.stage({
		inject: [PgClient.PgClient, SecureRandom.SecureRandom, Settings],
		services: AccessLayer.layer,
		publishes,
	})
	.start({
		inject: [...HttpMounts.inject, Auth],
		layer: HttpMounts.layer,
	})
