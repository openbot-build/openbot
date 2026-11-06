/** The authorization plugin: roles, and the checks of the permissions of each caller. */
import { PgClient } from "@effect/sql-pg"
import { SecureRandom } from "effect/crypto"
import { Layer } from "effect"
import { Tokens } from "@openbot-build/identity-contract/auth/Tokens"
import { Roles } from "@openbot-build/identity-contract/authorization/Roles"
import { Organization } from "@openbot-build/identity-contract/organization/Organization"
import { PlatformAdmins } from "@openbot-build/identity-contract/platform/PlatformAdmins"
import { Settings } from "@openbot-build/server-kernel/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
import * as AuthorizationLayer from "./Layer.ts"
import * as RolesPostgres from "./RolesPostgres.ts"

/** The keys that this plugin publishes. */
const publishes = [...AuthorizationLayer.published, Roles] as const

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
