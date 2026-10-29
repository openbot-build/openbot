import { PgClient } from "@effect/sql-pg"
import { Effect, Option } from "effect"
import { Settings } from "../settings/Settings.ts"
import * as Views from "../settings/Views.ts"

/** A server operator can read this snapshot without a user session. It has no secret values. */
export const inspect = Effect.gen(function* () {
	const settings = yield* Settings
	const sql = yield* PgClient.PgClient
	const platform = yield* settings.platform
	const admins = yield* sql<{
		email: string
		providerId: string
		userId: string | null
		active: boolean
	}>`
 select a.email,a.provider_id as "providerId",a.user_id as "userId",
 (a.user_id is null or coalesce(s.status,'active')='active') as active
 from openbot_platform_admins a left join openbot_account_states s on s.user_id=a.user_id order by a.email`
	const connections = yield* sql<{
		count: number
	}>`select count(*)::int as count from openbot_sso_connections`
	return {
		settings: Option.isSome(platform) ? Views.platform(platform.value) : null,
		admins,
		enabledSsoConnections: connections[0]?.count ?? 0,
	}
})
