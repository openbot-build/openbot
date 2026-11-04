/** The vaults plugin: Vaults, and the secret providers that they read. */
import { PgClient } from "@effect/sql-pg"
import { Authorization } from "@openbot-build/domain"
import { Layer } from "effect"
import { SecureRandom } from "effect/crypto"
import { Vaults } from "../apps-contract/vaults/Vaults.ts"
import { Bots } from "../conversation-contract/bots/Bots.ts"
import { AuditLog } from "../identity-contract/audit/AuditLog.ts"
import { Secrets } from "../server-kernel/secrets/Secrets.ts"
import * as Feature from "../server-plugin/Feature.ts"
import * as HttpMounts from "./HttpMounts.ts"
import { Readers } from "./Readers.ts"
import * as SecretProviders from "./SecretProviders.ts"
import * as VaultsLayer from "./Vaults.ts"

export const id = "vaults"

/** The keys that this plugin publishes. */
export const publishes = [SecretProviders.SecretProviders, Vaults] as const

export default Feature.make("@openbot-build/plugin-vaults")
	.stage({
		inject: [
			Authorization.Auth,
			Bots,
			PgClient.PgClient,
			Readers,
			Secrets,
			SecureRandom.SecureRandom,
		],
		services: VaultsLayer.layer.pipe(Layer.provideMerge(SecretProviders.layer)),
		publishes,
	})
	.start({
		inject: [...HttpMounts.inject, AuditLog],
		layer: HttpMounts.layer,
	})
