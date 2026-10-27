import { Model } from "@openbot-build/core"
import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import {
	Array as Arr,
	Clock,
	Context,
	Effect,
	Exit,
	Layer,
	Redacted,
} from "effect"
import { Billing, type Call, type Tokens } from "../src/billing/Billing.ts"
import * as BillingPostgres from "../src/billing/BillingPostgres.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as PostgresTest from "./PostgresTest.ts"

const call: Call = {
	organizationId: "unknown-org",
	providerId: "unknown-provider",
	providerOwner: "platform",
	modelId: "unknown-model",
}
const tokens = (inputUncached: number): Tokens => ({
	inputUncached,
	inputCacheRead: 0,
	inputCacheWrite: 0,
	outputText: 0,
	outputReasoning: 0,
})

const setup = Effect.gen(function* () {
	const database = yield* PostgresTest.start
	const databaseLayer = DatabasePostgres.layer({
		databaseUrl: Redacted.make(database.url),
	})
	yield* DatabasePostgres.migrate.pipe(Effect.provide(databaseLayer))
	const services = yield* Layer.build(
		BillingPostgres.layer.pipe(Layer.provideMerge(databaseLayer)),
	)
	const billing = Context.get(services, Billing)
	const sql = Context.get(services, PgClient.PgClient)
	yield* sql`insert into openbot_organizations (id, name, status, created_at) values (${call.organizationId}, 'Unknown usage', 'active', 0)`
	yield* sql`insert into openbot_model_providers (id, owner_kind, owner_id, kind, name, api_key, version, created_at, updated_at) values (${call.providerId}, 'platform', 'platform', 'openai-compat', 'Unknown usage', 'test key', 1, 0, 0)`
	yield* billing.setPrice(
		call.providerId,
		{
			model: Model.Id.make(call.modelId),
			tiers: [
				{
					upToInputTokens: null,
					inputUncached: 1_000_000,
					inputCacheRead: 0,
					inputCacheWrite: 0,
					output: 0,
					outputReasoning: null,
				},
			],
		},
		"root",
	)
	const events = Effect.gen(function* () {
		return yield* billing.events(
			call.organizationId,
			{ from: 0, to: (yield* Clock.currentTimeMillis) + 1 },
			{ limit: 10 },
		)
	})
	return { billing, sql, events }
})

it.live(
	"unknown usage releases budget room and keeps its estimate",
	() =>
		Effect.gen(function* () {
			const { billing, sql, events } = yield* setup
			yield* billing.createBudget(call.organizationId, {
				scope: "organization",
				period: "day",
				mode: "hard",
				limitMicros: 1000,
			})
			const first = yield* billing.reserve(
				call,
				{ source: "other" },
				tokens(1000),
			)
			yield* billing.unknown(first.id)
			yield* billing.unknown(first.id)
			assert.equal((yield* events).items[0]?.reservedMicros, 0)
			assert.equal((yield* events).items[0]?.estimatedMicros, 1000)
			assert.equal((yield* events).items[0]?.estimatedTokens, 1000)
			assert.isNull((yield* events).items[0]?.costMicros)
			// An old unknown call does not hold room in a later budget period.
			yield* sql`update openbot_usage_events set occurred_at = 0, started_at = 0 where id = ${first.id}`
			const competing = yield* Effect.forEach(
				[0, 1],
				() =>
					billing
						.reserve(call, { source: "other" }, tokens(1000))
						.pipe(Effect.exit),
				{ concurrency: 2 },
			)
			const accepted = Arr.filter(competing, Exit.isSuccess)
			assert.equal(accepted.length, 1)
			assert.equal(Arr.filter(competing, Exit.isFailure).length, 1)
			const second = accepted[0]!.value
			yield* billing.record(second.id, tokens(500))
			// Late receipts still count, but each call settles only once.
			yield* billing.record(first.id, tokens(500))
			yield* billing.record(first.id, tokens(500))
			const summary = yield* billing.summary(
				call.organizationId,
				{ from: 0, to: (yield* Clock.currentTimeMillis) + 1 },
				"source",
			)
			assert.equal(summary.total.costMicros, 1000)
			assert.equal(summary.total.calls, 2)
			assert.equal(summary.total.unknownCalls, 0)
			const spent = yield* billing
				.reserve(call, { source: "other" }, tokens(1))
				.pipe(Effect.flip)
			assert.equal(spent._tag, "SpendingBlocked")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	{ timeout: 60000 },
)

it.live(
	"unknown usage releases platform credits and late receipts charge once",
	() =>
		Effect.gen(function* () {
			const { billing, events } = yield* setup
			yield* billing.setCreditsEnabled(call.organizationId, true)
			yield* billing.grantCredits(
				call.organizationId,
				{ amountMicros: 1000, note: "Test credits" },
				"root",
			)
			const first = yield* billing.reserve(
				call,
				{ source: "other" },
				tokens(1000),
			)
			yield* billing.unknown(first.id)
			assert.equal((yield* events).items[0]?.reservedMicros, 0)
			assert.equal((yield* events).items[0]?.estimatedMicros, 1000)
			assert.equal(
				(yield* billing.credits(call.organizationId)).balanceMicros,
				1000,
			)
			const second = yield* billing.reserve(
				call,
				{ source: "other" },
				tokens(1000),
			)
			const denied = yield* billing
				.reserve(call, { source: "other" }, tokens(1))
				.pipe(Effect.flip)
			assert.equal(denied._tag, "SpendingBlocked")
			if (denied._tag === "SpendingBlocked")
				assert.equal(denied.reason, "credits")
			yield* billing.record(second.id, tokens(500))
			yield* billing.record(first.id, tokens(500))
			yield* billing.record(first.id, tokens(500))
			assert.equal(
				(yield* billing.credits(call.organizationId)).balanceMicros,
				0,
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	{ timeout: 60000 },
)

it.live(
	"a receipt above its estimate keeps the full cost",
	() =>
		Effect.gen(function* () {
			const { billing, events } = yield* setup
			yield* billing.createBudget(call.organizationId, {
				scope: "organization",
				period: "day",
				mode: "hard",
				limitMicros: 1000,
			})
			const first = yield* billing.reserve(
				call,
				{ source: "other" },
				tokens(1000),
			)
			yield* billing.unknown(first.id)
			yield* billing.record(first.id, tokens(2000))
			assert.equal((yield* events).items[0]?.costMicros, 2000)
			assert.equal((yield* events).items[0]?.reservedMicros, 0)
			const denied = yield* billing
				.reserve(call, { source: "other" }, tokens(1))
				.pipe(Effect.flip)
			assert.equal(denied._tag, "SpendingBlocked")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	{ timeout: 60000 },
)

it.live(
	"an old unknown estimate does not block its budget scope",
	() =>
		Effect.gen(function* () {
			const { billing, sql } = yield* setup
			yield* sql`insert into openbot_auth_user (id, name, email, email_verified, created_at, updated_at) values ('ana', 'Ana', 'ana@example.com', true, now(), now()), ('bob', 'Bob', 'bob@example.com', true, now(), now())`
			yield* sql`insert into openbot_members (user_id, organization_id, status, roles, policy, joined_at) values ('ana', ${call.organizationId}, 'active', '[]', '[]', 0), ('bob', ${call.organizationId}, 'active', '[]', '[]', 0)`
			const ana = yield* billing.createBudget(call.organizationId, {
				scope: "member",
				scopeId: "ana",
				period: "day",
				mode: "hard",
				limitMicros: 1000,
			})
			yield* billing.createBudget(call.organizationId, {
				scope: "member",
				scopeId: "bob",
				period: "day",
				mode: "hard",
				limitMicros: 1000,
			})
			const first = yield* billing.reserve(
				call,
				{ source: "other", userId: "ana" },
				tokens(500),
			)
			// This is the stored state left by the old release rule.
			yield* sql`update openbot_usage_events set status = 'unknown', reserved_micros = 0, estimated_micros = null, reservation_known = false where id = ${first.id}`
			const bob = yield* billing.reserve(
				call,
				{ source: "other", userId: "bob" },
				tokens(500),
			)
			yield* billing.record(bob.id, tokens(500))
			const next = yield* billing.reserve(
				call,
				{ source: "other", userId: "ana" },
				tokens(500),
			)
			yield* billing.record(next.id, tokens(500))
			yield* billing.record(first.id, tokens(500))
			const denied = yield* billing
				.reserve(call, { source: "other", userId: "ana" }, tokens(1))
				.pipe(Effect.flip)
			assert.equal(denied._tag, "SpendingBlocked")
			if (denied._tag === "SpendingBlocked")
				assert.equal(denied.budgetId, ana.id)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	{ timeout: 60000 },
)

it.live(
	"an old unknown estimate does not block platform credits",
	() =>
		Effect.gen(function* () {
			const { billing, sql } = yield* setup
			yield* billing.setCreditsEnabled(call.organizationId, true)
			yield* billing.grantCredits(
				call.organizationId,
				{ amountMicros: 1000, note: "Test credits" },
				"root",
			)
			const first = yield* billing.reserve(
				call,
				{ source: "other" },
				tokens(500),
			)
			yield* sql`update openbot_usage_events set status = 'unknown', reserved_micros = 0, estimated_micros = null, reservation_known = false where id = ${first.id}`
			const next = yield* billing.reserve(
				call,
				{ source: "other" },
				tokens(500),
			)
			yield* billing.record(next.id, tokens(500))
			yield* billing.record(first.id, tokens(500))
			assert.equal(
				(yield* billing.credits(call.organizationId)).balanceMicros,
				0,
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	{ timeout: 60000 },
)

it.live(
	"a zero estimate remains known after its hold is released",
	() =>
		Effect.gen(function* () {
			const { billing, sql } = yield* setup
			yield* billing.createBudget(call.organizationId, {
				scope: "organization",
				period: "day",
				mode: "hard",
				limitMicros: 1000,
			})
			yield* billing.setCreditsEnabled(call.organizationId, true)
			yield* billing.grantCredits(
				call.organizationId,
				{ amountMicros: 1000, note: "Test credits" },
				"root",
			)
			const first = yield* billing.reserve(
				call,
				{ source: "other" },
				{
					...tokens(0),
					inputCacheRead: 1000,
				},
			)
			yield* billing.unknown(first.id)
			const [row] = yield* sql<{
				estimate: number | null
			}>`select estimated_micros::int as estimate from openbot_usage_events where id = ${first.id}`
			assert.equal(row?.estimate, 0)
			const next = yield* billing.reserve(
				call,
				{ source: "other" },
				tokens(1000),
			)
			yield* billing.record(next.id, tokens(1000))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	{ timeout: 60000 },
)

it.live(
	"an old free call does not block a later paid call",
	() =>
		Effect.gen(function* () {
			const { billing, sql } = yield* setup
			const setPrice = (inputUncached: number) =>
				billing.setPrice(
					call.providerId,
					{
						model: Model.Id.make(call.modelId),
						tiers: [
							{
								upToInputTokens: null,
								inputUncached,
								inputCacheRead: 0,
								inputCacheWrite: 0,
								output: 0,
								outputReasoning: null,
							},
						],
					},
					"root",
				)
			// This call is free in its time window, though the base price is not.
			yield* billing.setPrice(
				call.providerId,
				{
					model: Model.Id.make(call.modelId),
					timeZone: "UTC",
					tiers: [
						{
							upToInputTokens: null,
							inputUncached: 1_000_000,
							inputCacheRead: 0,
							inputCacheWrite: 0,
							output: 0,
							outputReasoning: null,
						},
					],
					periods: [
						{
							name: "Free",
							windows: [{ start: "00:00", end: "24:00" }],
							tiers: [
								{
									upToInputTokens: null,
									inputUncached: 0,
									inputCacheRead: 0,
									inputCacheWrite: 0,
									output: 0,
									outputReasoning: null,
								},
							],
						},
					],
				},
				"root",
			)
			yield* billing.createBudget(call.organizationId, {
				scope: "organization",
				period: "day",
				mode: "hard",
				limitMicros: 1000,
			})
			const first = yield* billing.reserve(
				call,
				{ source: "other" },
				tokens(1000),
			)
			yield* sql`update openbot_usage_events set status = 'unknown', reserved_micros = 0, estimated_micros = null, reservation_known = false where id = ${first.id}`
			yield* setPrice(1_000_000)
			const next = yield* billing.reserve(
				call,
				{ source: "other" },
				tokens(1000),
			)
			yield* billing.record(next.id, tokens(1000))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	{ timeout: 60000 },
)
