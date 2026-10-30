import { PgClient } from "@effect/sql-pg"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { Billing } from "./Billing.ts"
import { Organization } from "../organization/Organization.ts"
import { Settings } from "../settings/Settings.ts"
import * as Platform from "../settings/Platform.ts"
import type {
	Billing as BillingModel,
	Organizations as OrganizationsModel,
	Settings as SettingsModel,
} from "@openbot-build/domain"
import type { SqlError } from "effect/sql/SqlError"
import type { OrganizationUnavailable } from "../organization/Organization.ts"

export interface Snapshot extends BillingModel.Credits {
	readonly heldMicros: number
	readonly availableMicros: number
	readonly space: OrganizationsModel.Organization | null
}
/** A host uses these public operations without writing OpenBot tables. */
export class Wallets extends Context.Service<
	Wallets,
	{
		readonly credits: (typeof Billing.Service)["credits"]
		readonly grant: (typeof Billing.Service)["grantCredits"]
		readonly space: (typeof Organization.Service)["get"]
		readonly publicOrigin: Effect.Effect<
			string,
			SettingsModel.SettingsUnavailable | SettingsModel.SetupRequired
		>
		readonly activatePrepaid: Effect.Effect<void, SqlError>
		readonly snapshot: (
			id: string,
		) => Effect.Effect<
			Snapshot,
			| import("./Billing.ts").BillingStorageError
			| import("./Billing.ts").OrganizationMissing
			| OrganizationUnavailable
			| SqlError
		>
	}
>()("@openbot-build/openbot/billing/Host/Wallets") {}

export const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient
	const billing = yield* Billing
	const organizations = yield* Organization
	const settings = yield* Settings
	return {
		credits: billing.credits,
		grant: billing.grantCredits,
		space: (id: string) => organizations.get(id),
		publicOrigin: Platform.publicOrigin(settings),
		/** Called before serving a prepaid host. No balance is changed. */
		activatePrepaid: sql.withTransaction(
			Effect.gen(function* () {
				// Serialize creation with this cutover, including other server instances.
				yield* sql`lock table openbot_organizations in share row exclusive mode`
				yield* sql`insert into openbot_billing_policy(id,prepaid) values('platform',true) on conflict(id) do update set prepaid=true`
				const now = yield* Clock.currentTimeMillis
				yield* sql`insert into openbot_organization_credits(organization_id,enabled,balance_micros,updated_at) select id,true,0,${now} from openbot_organizations on conflict(organization_id) do update set enabled=true`
			}),
		),
		snapshot: (id: string) =>
			Effect.gen(function* () {
				const credits = yield* billing.credits(id)
				const space = yield* organizations.get(id)
				const [held] = yield* sql<{
					held: number
				}>`select coalesce(sum(case when status in ('pending','unknown') then greatest(reserved_micros,coalesce(estimated_micros,0)) else reserved_micros end),0)::float8 as held from openbot_usage_events where organization_id=${id} and provider_owner='platform'`
				const heldMicros = held?.held ?? 0
				return {
					...credits,
					heldMicros,
					availableMicros: credits.balanceMicros - heldMicros,
					space: Option.getOrNull(space),
				}
			}),
	}
})

export const layer = Layer.effect(Wallets, make)
