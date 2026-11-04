/** The access plugin: who may join the platform, and how. */
import { PgClient } from "@effect/sql-pg"
import { SecureRandom } from "effect/crypto"
import * as AccessLayer from "../identity-contract/access/Access.ts"
import { Auth } from "../identity-contract/auth/Auth.ts"
import { Settings } from "../server-kernel/settings/Settings.ts"
import * as Feature from "../server-plugin/Feature.ts"
import * as HttpMounts from "./HttpMounts.ts"

export const id = "access"

/** The keys that this plugin publishes. */
export const publishes = [AccessLayer.Access] as const

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
