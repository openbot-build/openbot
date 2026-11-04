/** The models plugin: model providers, models, and the model registry. */
import { PgClient } from "@effect/sql-pg"
import { Authorization } from "@openbot-build/domain"
import { Digest, SecureRandom } from "effect/crypto"
import { HttpClient } from "effect/http"
import { AuditLog } from "../identity-contract/audit/AuditLog.ts"
import { LiveBackends } from "../models-contract/models/LiveBackends.ts"
import { ModelProviders } from "../models-contract/models/ModelProviders.ts"
import { ModelRegistry } from "../models-contract/models/ModelRegistry.ts"
import { Models } from "../models-contract/models/Models.ts"
import { ProviderOAuth } from "../models-contract/models/ProviderOAuth.ts"
import { Billing } from "../server-billing/billing/Billing.ts"
import { TokenThrottle } from "../server-billing/billing/TokenThrottle.ts"
import { Records } from "../server-kernel/errors/Records.ts"
import { Secrets } from "../server-kernel/secrets/Secrets.ts"
import { Settings } from "../server-kernel/settings/Settings.ts"
import * as Feature from "../server-plugin/Feature.ts"
import * as HttpMounts from "./HttpMounts.ts"
import * as Layers from "./Layers.ts"

export const id = "models"

/** The keys that this plugin publishes. */
export const publishes = [
	ModelProviders,
	ModelRegistry,
	Models,
	ProviderOAuth,
] as const

export default Feature.make("@openbot-build/plugin-models")
	.stage({
		inject: [
			Billing,
			Digest.Digest,
			HttpClient.HttpClient,
			LiveBackends,
			PgClient.PgClient,
			Records,
			Secrets,
			SecureRandom.SecureRandom,
			Settings,
			TokenThrottle,
		],
		services: Layers.layerModels,
		publishes,
	})
	.start({
		inject: [...HttpMounts.inject, AuditLog, Authorization.Auth],
		layer: HttpMounts.layer,
	})
