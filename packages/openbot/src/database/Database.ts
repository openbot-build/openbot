import { defineRelations } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import type { Effect } from "effect"
import * as AuthSchema from "./AuthSchema.ts"
import * as Schema from "./Schema.ts"

/**
 * The Drizzle relations of every table. They follow the foreign keys in the
 * schema, so relational queries (`db.query`) can join the tables.
 */
export const relations = defineRelations({ ...Schema, ...AuthSchema }, (r) => ({
	organizations: {
		roles: r.many.roles(),
		domains: r.many.organizationDomains(),
		ssoConnections: r.many.ssoConnections(),
		members: r.many.members(),
		tokens: r.many.tokens(),
		budgets: r.many.budgets(),
		credits: r.one.organizationCredits({
			from: r.organizations.id,
			to: r.organizationCredits.organizationId,
		}),
		creditGrants: r.many.creditGrants(),
	},
	openbot_auth_user: {
		sessions: r.many.openbot_auth_session(),
		accounts: r.many.openbot_auth_account(),
		platformAdmin: r.one.platformAdmins({
			from: r.openbot_auth_user.id,
			to: r.platformAdmins.userId,
		}),
		members: r.many.members(),
		tokens: r.many.tokens(),
		channelIdentities: r.many.channelIdentities(),
	},
	openbot_auth_session: {
		user: r.one.openbot_auth_user({
			from: r.openbot_auth_session.userId,
			to: r.openbot_auth_user.id,
			optional: false,
		}),
	},
	openbot_auth_account: {
		user: r.one.openbot_auth_user({
			from: r.openbot_auth_account.userId,
			to: r.openbot_auth_user.id,
			optional: false,
		}),
	},
	platformAdmins: {
		user: r.one.openbot_auth_user({
			from: r.platformAdmins.userId,
			to: r.openbot_auth_user.id,
		}),
	},
	roles: {
		organization: r.one.organizations({
			from: r.roles.organizationId,
			to: r.organizations.id,
			optional: false,
		}),
	},
	organizationDomains: {
		organization: r.one.organizations({
			from: r.organizationDomains.organizationId,
			to: r.organizations.id,
			optional: false,
		}),
	},
	ssoConnections: {
		organization: r.one.organizations({
			from: r.ssoConnections.organizationId,
			to: r.organizations.id,
			optional: false,
		}),
	},
	members: {
		organization: r.one.organizations({
			from: r.members.organizationId,
			to: r.organizations.id,
			optional: false,
		}),
		user: r.one.openbot_auth_user({
			from: r.members.userId,
			to: r.openbot_auth_user.id,
			optional: false,
		}),
	},
	tokens: {
		organization: r.one.organizations({
			from: r.tokens.organizationId,
			to: r.organizations.id,
			optional: false,
		}),
		user: r.one.openbot_auth_user({
			from: r.tokens.userId,
			to: r.openbot_auth_user.id,
			optional: false,
		}),
	},
	channelIdentities: {
		user: r.one.openbot_auth_user({
			from: r.channelIdentities.userId,
			to: r.openbot_auth_user.id,
		}),
	},
	modelProviders: {
		models: r.many.providerModels(),
		prices: r.many.modelPrices(),
	},
	providerModels: {
		provider: r.one.modelProviders({
			from: r.providerModels.providerId,
			to: r.modelProviders.id,
			optional: false,
		}),
	},
	modelPrices: {
		provider: r.one.modelProviders({
			from: r.modelPrices.providerId,
			to: r.modelProviders.id,
			optional: false,
		}),
	},
	budgets: {
		organization: r.one.organizations({
			from: r.budgets.organizationId,
			to: r.organizations.id,
			optional: false,
		}),
	},
	organizationCredits: {
		organization: r.one.organizations({
			from: r.organizationCredits.organizationId,
			to: r.organizations.id,
			optional: false,
		}),
	},
	creditGrants: {
		organization: r.one.organizations({
			from: r.creditGrants.organizationId,
			to: r.organizations.id,
			optional: false,
		}),
	},
}))

/**
 * The Drizzle database on the current `PgClient`. This is the only place that
 * builds it, so every module gets the same relations. Queries join the
 * transaction of the `PgClient` when one is open.
 */
export const make = makeWithDefaults({ relations })

export type Database = Effect.Success<typeof make>
