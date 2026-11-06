/**
 * The public credit operations of OpenBot. A host that sells credits uses
 * them in its own routes, without writing OpenBot tables. The host runs them
 * as a fork of its own, so no plugin publishes them.
 */
import type { SettingsUnavailable } from "@openbot-build/domain/SettingsErrors"
import { PgClient } from "@effect/sql-pg"
import type {
	Billing as BillingModel,
	Organizations as OrganizationsModel,
	Settings as SettingsModel,
} from "@openbot-build/domain"
import {
	Organization,
	type OrganizationUnavailable,
} from "@openbot-build/identity-contract/organization/Organization"
import {
	Billing,
	type BillingStorageError,
	type OrganizationMissing,
} from "@openbot-build/server-billing/Billing"
import * as Platform from "@openbot-build/server-kernel/Platform"
import { Settings } from "@openbot-build/server-kernel/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
import { Clock, Context, Effect, Layer, Option } from "effect"
import type { SqlError } from "effect/sql/SqlError"

/** The credits of one organization, with the amount that running calls hold. */
export interface Snapshot extends BillingModel.Credits {
	readonly heldMicros: number
	readonly availableMicros: number
	readonly space: OrganizationsModel.Organization | null
}

/** The credit operations. */
export class Wallets extends Context.Service<
	Wallets,
	{
		readonly credits: (typeof Billing.Service)["credits"]
		readonly grant: (typeof Billing.Service)["grantCredits"]
		readonly space: (typeof Organization.Service)["get"]
		readonly publicOrigin: Effect.Effect<
			string,
			SettingsUnavailable | SettingsModel.SetupRequired
		>
		/** Called before serving a prepaid host. No balance is changed. */
		readonly activatePrepaid: Effect.Effect<void, SqlError>
		readonly snapshot: (
			id: string,
		) => Effect.Effect<
			Snapshot,
			| BillingStorageError
			| OrganizationMissing
			| OrganizationUnavailable
			| SqlError
		>
	}
>()("@openbot-build/openbot/Wallets") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient
	const billing = yield* Billing
	const organizations = yield* Organization
	const settings = yield* Settings
	return Wallets.of({
		credits: billing.credits,
		grant: billing.grantCredits,
		space: (id: string) => organizations.get(id),
		publicOrigin: Platform.publicOrigin(settings),
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
				}>`select coalesce(sum(reserved_micros),0)::float8 as held from openbot_usage_events where organization_id=${id} and provider_owner='platform'`
				const heldMicros = held?.held ?? 0
				return {
					...credits,
					heldMicros,
					availableMicros: credits.balanceMicros - heldMicros,
					space: Option.getOrNull(space),
				}
			}),
	})
})

/**
 * The credit operations, from the bills of the kernel and the organizations
 * of the organization plugin. It needs the database pool and the settings too.
 */
export const layer = Layer.effect(Wallets, make)

/**
 * The fork of the host that publishes `Wallets`. It waits for the
 * organization plugin, which is always on.
 */
export const plugin = Feature.make("openbot.wallets")
	.stage({
		inject: [Organization, Billing, PgClient.PgClient, Settings],
		services: layer,
		publishes: [Wallets],
	})
	.done()
