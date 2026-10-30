import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Context, Effect, Exit, Layer, Redacted, Schema } from "effect"
import { Billing as Model } from "@openbot-build/domain"
import { Model as CoreModel } from "@openbot-build/core"
import { Billing as BillingService } from "../src/billing/Billing.ts"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as Billing from "../src/billing/BillingPostgres.ts"
import * as Host from "../src/billing/Host.ts"
import * as Organizations from "../src/organization/OrganizationPostgres.ts"
import { Organization } from "../src/organization/Organization.ts"
import * as Audit from "../src/audit/AuditLogPostgres.ts"
import * as PostgresTest from "./PostgresTest.ts"
import { layerSettings } from "./OrganizationFixture.ts"

const fixture = Effect.gen(function* () {
	const database = yield* PostgresTest.start
	const db = Database.layer({ databaseUrl: Redacted.make(database.url) })
	yield* Database.migrate.pipe(Effect.provide(db))
	const services = yield* Layer.build(
		Host.layer.pipe(
			Layer.provideMerge(Layer.merge(Billing.layer, Organizations.layer)),
			Layer.provide(layerSettings()),
			Layer.provide(Audit.layer),
			Layer.provideMerge(db),
		),
	)
	const sql = Context.get(services, PgClient.PgClient)
	const organizations = Context.get(services, Organization)
	const wallets = Context.get(services, Host.Wallets)
	yield* sql`insert into openbot_auth_user(id,name,email,email_verified) values('alice','Alice','alice@example.com',true),('bob','Bob','bob@example.com',true)`
	yield* sql`insert into openbot_organizations(id,name,status,created_at) values('old_personal','Personal','active',0)`
	return {
		sql,
		organizations,
		wallets,
		billing: Context.get(services, BillingService),
	}
})

it.live(
	"private spaces are unique, preserve old organizations, and cannot gain other members",
	() =>
		Effect.gen(function* () {
			const { sql, organizations } = yield* fixture
			const ids = yield* Effect.all(
				[
					organizations.ensurePersonal({ id: "alice" }),
					organizations.ensurePersonal({ id: "alice" }),
				],
				{ concurrency: 2 },
			)
			assert.equal(ids[0], ids[1])
			assert.notEqual(ids[0], "old_personal")
			const bob = yield* organizations.ensurePersonal({ id: "bob" })
			assert.notEqual(bob, ids[0])
			const membership = yield* organizations.memberships("alice")
			assert.equal(membership[0]?.kind, "personal")
			assert.equal(membership[0]?.ownerUserId, "alice")
			const join = yield* Effect.exit(
				sql`insert into openbot_members(organization_id,user_id,status,roles,policy,joined_at) values(${ids[0]},'bob','active','["member"]','{}',0)`,
			)
			assert.isTrue(Exit.isFailure(join))
			assert.isTrue(
				Exit.isFailure(
					yield* Effect.exit(organizations.removeMember(ids[0]!, "alice")),
				),
			)
			const invite = yield* Effect.exit(
				organizations.createInvitation({
					organizationId: ids[0]!,
					email: "bob@example.com",
					roles: ["member"],
					invitedBy: "alice",
				}),
			)
			assert.isTrue(Exit.isFailure(invite))
			const [old] = yield* sql<{
				owner: string | null
			}>`select personal_owner_user_id as owner from openbot_organizations where id='old_personal'`
			assert.equal(old?.owner, null)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	{ timeout: 60000 },
)

it.live(
	"credit retries and conflicts preserve one balance and one audit record",
	() =>
		Effect.gen(function* () {
			const { wallets, sql } = yield* fixture
			const input = {
				amountMicros: 25_000_000,
				note: "Payment one",
				operationKey: "stripe:payment:one",
			}
			const grants = yield* Effect.all(
				[
					wallets.grant("old_personal", input, "alice"),
					wallets.grant("old_personal", input, "alice"),
				],
				{ concurrency: 2 },
			)
			assert.equal(grants[0].id, grants[1].id)
			assert.equal(
				(yield* wallets.credits("old_personal")).balanceMicros,
				25_000_000,
			)
			const conflict = yield* Effect.result(
				wallets.grant(
					"old_personal",
					{ ...input, amountMicros: 50_000_000 },
					"alice",
				),
			)
			assert.equal(conflict._tag, "Failure")
			if (conflict._tag === "Failure")
				assert.isTrue(Schema.is(Model.CreditConflict)(conflict.failure))
			const [audit] = yield* sql<{
				count: number
			}>`select count(*)::int as count from openbot_audit_logs where action='credits.granted'`
			assert.equal(audit?.count, 1)
			yield* wallets.grant(
				"old_personal",
				{
					amountMicros: -5_000_000,
					note: "Partial refund",
					operationKey: "stripe:refund:one",
				},
				"alice",
			)
			assert.equal(
				(yield* wallets.credits("old_personal")).balanceMicros,
				20_000_000,
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	{ timeout: 60000 },
)

it.live(
	"prepaid cutover keeps money and applies to old and future spaces",
	() =>
		Effect.gen(function* () {
			const { wallets, organizations, sql } = yield* fixture
			yield* wallets.grant(
				"old_personal",
				{ amountMicros: 9000000, note: "Existing credits" },
				"alice",
			)
			assert.isFalse((yield* wallets.credits("old_personal")).enabled)
			yield* wallets.activatePrepaid
			yield* wallets.activatePrepaid
			assert.equal(
				(yield* wallets.credits("old_personal")).balanceMicros,
				9000000,
			)
			assert.isTrue((yield* wallets.credits("old_personal")).enabled)
			const personal = yield* organizations.ensurePersonal({ id: "alice" })
			assert.isTrue((yield* wallets.credits(personal)).enabled)
			assert.equal((yield* wallets.credits(personal)).balanceMicros, 0)
			yield* sql`update openbot_organization_credits set enabled=false where organization_id=${personal}`
			assert.isTrue((yield* wallets.credits(personal)).enabled)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	{ timeout: 60000 },
)

it.live(
	"personal spending never uses organization money and debt blocks platform calls",
	() =>
		Effect.gen(function* () {
			const { wallets, organizations, billing, sql } = yield* fixture
			yield* wallets.activatePrepaid
			const personal = yield* organizations.ensurePersonal({ id: "alice" })
			yield* wallets.grant(
				"old_personal",
				{ amountMicros: 9000, note: "Team funds" },
				"alice",
			)
			yield* sql`insert into openbot_model_providers(id,owner_kind,owner_id,kind,name,api_key,version,created_at,updated_at) values('wallet_provider','platform','platform','openai-compat','Wallet model','test key',1,0,0)`
			yield* billing.setPrice(
				"wallet_provider",
				{
					model: CoreModel.Id.make("wallet_model"),
					tiers: [
						{
							upToInputTokens: null,
							inputUncached: 1000000,
							inputCacheRead: 0,
							inputCacheWrite: 0,
							output: 0,
							outputReasoning: null,
						},
					],
				},
				"alice",
			)
			const call = {
				organizationId: personal,
				providerId: "wallet_provider",
				providerOwner: "platform" as const,
				modelId: "wallet_model",
			}
			const tokens = {
				inputUncached: 1000,
				inputCacheRead: 0,
				inputCacheWrite: 0,
				outputText: 0,
				outputReasoning: 0,
			}
			const denied = yield* Effect.result(
				billing.reserve(call, { source: "other" }, tokens),
			)
			assert.equal(denied._tag, "Failure")
			if (denied._tag === "Failure")
				assert.equal(denied.failure._tag, "SpendingBlocked")
			yield* wallets.grant(
				personal,
				{ amountMicros: 2500, note: "Personal funds" },
				"alice",
			)
			const reservation = yield* billing.reserve(
				call,
				{ source: "other" },
				tokens,
			)
			assert.equal((yield* wallets.snapshot(personal)).heldMicros, 1000)
			yield* billing.record(reservation.id, tokens)
			assert.equal((yield* wallets.credits(personal)).balanceMicros, 1500)
			assert.equal((yield* wallets.credits("old_personal")).balanceMicros, 9000)
			yield* wallets.grant(
				personal,
				{ amountMicros: -2000, note: "Refund after spending" },
				"alice",
			)
			assert.equal((yield* wallets.credits(personal)).balanceMicros, -500)
			assert.equal(
				(yield* Effect.result(
					billing.reserve(call, { source: "other" }, tokens),
				))._tag,
				"Failure",
			)
			const own = yield* billing.reserve(
				{ ...call, providerOwner: "organization" },
				{ source: "other" },
				tokens,
			)
			yield* billing.record(own.id, tokens)
			assert.equal((yield* wallets.credits(personal)).balanceMicros, -500)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	{ timeout: 60000 },
)
