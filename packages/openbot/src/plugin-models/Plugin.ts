/** The models plugin: model providers, models, and the model registry. */
import { PgClient } from "@effect/sql-pg"
import { Authorization } from "@openbot-build/domain"
import { Digest, SecureRandom } from "effect/crypto"
import { HttpClient } from "effect/http"
import { AuditLog } from "@openbot-build/identity-contract/audit/AuditLog"
import { LiveBackends } from "@openbot-build/models-contract/models/LiveBackends"
import { ModelProviders } from "@openbot-build/models-contract/models/ModelProviders"
import { ModelRegistry } from "@openbot-build/models-contract/models/ModelRegistry"
import { Models } from "@openbot-build/models-contract/models/Models"
import { ProviderOAuth } from "@openbot-build/models-contract/models/ProviderOAuth"
import { Billing } from "@openbot-build/server-billing/billing/Billing"
import { TokenThrottle } from "@openbot-build/server-billing/billing/TokenThrottle"
import { Records } from "@openbot-build/server-kernel/errors/Records"
import { Secrets } from "@openbot-build/server-kernel/secrets/Secrets"
import { Settings } from "@openbot-build/server-kernel/settings/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
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
