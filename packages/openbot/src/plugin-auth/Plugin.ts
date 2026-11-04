/** The auth plugin: sign-in with Better Auth, user tokens, and the middleware that checks callers. */
import { PgClient } from "@effect/sql-pg"
import { Digest, SecureRandom } from "effect/crypto"
import { Effect, Layer } from "effect"
import { Access } from "../identity-contract/access/Access.ts"
import { AuditLog } from "../identity-contract/audit/AuditLog.ts"
import { Auth } from "../identity-contract/auth/Auth.ts"
import { Tokens } from "../identity-contract/auth/Tokens.ts"
import { Mail } from "../identity-contract/mail/Mail.ts"
import { Organization } from "../identity-contract/organization/Organization.ts"
import { PlatformAdmins } from "../identity-contract/platform/PlatformAdmins.ts"
import { Sso } from "../identity-contract/sso/Sso.ts"
import { RateLimiter } from "../server-billing/billing/RateLimit.ts"
import { InstanceSettings } from "../server-kernel/configuration/InstanceSettings.ts"
import { Records } from "../server-kernel/errors/Records.ts"
import { Secrets } from "../server-kernel/secrets/Secrets.ts"
import { Settings } from "../server-kernel/settings/Settings.ts"
import * as Feature from "../server-plugin/Feature.ts"
import * as BetterAuth from "./BetterAuth.ts"
import * as HttpHandlers from "./HttpHandlers.ts"
import * as HttpMiddleware from "./HttpMiddleware.ts"
import * as HttpMounts from "./HttpMounts.ts"
import * as TokensPostgres from "./TokensPostgres.ts"

export const id = "auth"

/** The keys that this plugin publishes. */
export const publishes = [Auth, Tokens, ...HttpMiddleware.published] as const

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
