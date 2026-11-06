/** The auth plugin: sign-in with Better Auth, user tokens, and the middleware that checks callers. */
import { PgClient } from "@effect/sql-pg"
import { Digest, SecureRandom } from "effect/crypto"
import { Effect, Layer } from "effect"
import { Access } from "@openbot-build/identity-contract/access/Access"
import { AuditLog } from "@openbot-build/identity-contract/audit/AuditLog"
import { Auth } from "@openbot-build/identity-contract/auth/Auth"
import { Tokens } from "@openbot-build/identity-contract/auth/Tokens"
import { Mail } from "@openbot-build/identity-contract/mail/Mail"
import { Organization } from "@openbot-build/identity-contract/organization/Organization"
import { PlatformAdmins } from "@openbot-build/identity-contract/platform/PlatformAdmins"
import { Sso } from "@openbot-build/identity-contract/sso/Sso"
import { RateLimiter } from "@openbot-build/server-billing/RateLimit"
import { InstanceSettings } from "@openbot-build/server-kernel/InstanceSettings"
import { Records } from "@openbot-build/server-kernel/Records"
import { Secrets } from "@openbot-build/server-kernel/Secrets"
import { Settings } from "@openbot-build/server-kernel/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
import * as BetterAuth from "./BetterAuth.ts"
import * as HttpHandlers from "./HttpHandlers.ts"
import * as HttpMiddleware from "./HttpMiddleware.ts"
import * as HttpMounts from "./HttpMounts.ts"
import * as TokensPostgres from "./TokensPostgres.ts"

/** The keys that this plugin publishes. */
const publishes = [Auth, Tokens, ...HttpMiddleware.published] as const

/** Better Auth with the database and the mode of this instance. */
const layerBetterAuth = Layer.unwrap(
	Effect.map(InstanceSettings, (instance) =>
		BetterAuth.layer({
			databaseUrl: instance.databaseUrl,
			development: instance.development,
		}),
	),
)

export default Feature.make("@openbot-build/plugin-auth")
	.stage({
		inject: [
			Access,
			Mail,
			Organization,
			PlatformAdmins,
			Sso,
			Digest.Digest,
			InstanceSettings,
			PgClient.PgClient,
			RateLimiter,
			Records,
			Secrets,
			SecureRandom.SecureRandom,
			Settings,
		],
		services: HttpHandlers.layerMiddleware.pipe(
			Layer.provideMerge(layerBetterAuth),
			Layer.provideMerge(TokensPostgres.layer),
		),
		publishes,
	})
	.start({
		inject: [...HttpMounts.inject, AuditLog],
		layer: HttpMounts.layer,
	})
