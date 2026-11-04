/** The authorization plugin: roles, and the checks of the permissions of each caller. */
import { PgClient } from "@effect/sql-pg"
import { SecureRandom } from "effect/crypto"
import { Layer } from "effect"
import { Tokens } from "../identity-contract/auth/Tokens.ts"
import { Roles } from "../identity-contract/authorization/Roles.ts"
import { Organization } from "../identity-contract/organization/Organization.ts"
import { PlatformAdmins } from "../identity-contract/platform/PlatformAdmins.ts"
import { Settings } from "../server-kernel/settings/Settings.ts"
import * as Feature from "../server-plugin/Feature.ts"
import * as AuthorizationLayer from "./Layer.ts"
import * as RolesPostgres from "./RolesPostgres.ts"

export const id = "authorization"

/** The keys that this plugin publishes. */
export const publishes = [...AuthorizationLayer.published, Roles] as const

export default Feature.make("@openbot-build/plugin-authorization")
	.stage({
		inject: [
			Organization,
			PlatformAdmins,
			Tokens,
			PgClient.PgClient,
			SecureRandom.SecureRandom,
			Settings,
		],
		services: AuthorizationLayer.layer.pipe(
			Layer.provideMerge(RolesPostgres.layer),
		),
		publishes,
	})
	.done()
