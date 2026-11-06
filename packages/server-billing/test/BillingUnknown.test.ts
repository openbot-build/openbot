import * as TestDatabase from "@openbot-build/server-database/Testing"
import * as Migrations from "@openbot-build/server-database/Migrations"
import { Model } from "@openbot-build/core"
import { assert, it } from "@effect/vitest"
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Clock, Context, Effect, Layer, Redacted } from "effect"
import { Billing, type Call, type Tokens } from "../src/Billing.ts"
import * as BillingPostgres from "../src/BillingPostgres.ts"

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
	const database = yield* TestDatabase.start
	const databaseLayer = PgClient.layer({
		url: Redacted.make(database.url),
	})
	yield* Migrations.migrate.pipe(Effect.provide(databaseLayer))
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
	"unknown usage keeps its budget hold across periods",
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
			assert.equal((yield* events).items[0]?.reservedMicros, 1000)
			assert.equal((yield* events).items[0]?.estimatedMicros, 1000)
			assert.equal((yield* events).items[0]?.estimatedTokens, 1000)
			assert.isNull((yield* events).items[0]?.costMicros)
			// A new budget period does not free an unknown call's hold.
			yield* sql`update openbot_usage_events set occurred_at = 0, started_at = 0 where id = ${first.id}`
			const competing = yield* Effect.forEach(
				[0, 1],
				() =>
					billing
						.reserve(call, { source: "other" }, tokens(1000))
						.pipe(Effect.flip),
				{ concurrency: 2 },
			)
			for (const denied of competing) {
				assert.equal(denied._tag, "SpendingBlocked")
				if (denied._tag === "SpendingBlocked")
					assert.equal(denied.reason, "budget")
			}
			// Late receipts still count, but each call settles only once.
			yield* billing.record(first.id, tokens(500))
			yield* billing.record(first.id, tokens(500))
			assert.equal((yield* events).items[0]?.reservedMicros, 0)
			const second = yield* billing.reserve(
				call,
				{ source: "other" },
				tokens(500),
			)
			const held = yield* billing
				.reserve(call, { source: "other" }, tokens(1))
				.pipe(Effect.flip)
			assert.equal(held._tag, "SpendingBlocked")
			yield* billing.record(second.id, tokens(500))
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
		}).pipe(
			Effect.scoped,
			Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
		),
	{ timeout: 60000 },
)

it.live(
	"unknown usage keeps platform credits until a late receipt",
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
			assert.equal((yield* events).items[0]?.reservedMicros, 1000)
			assert.equal((yield* events).items[0]?.estimatedMicros, 1000)
			assert.equal(
				(yield* billing.credits(call.organizationId)).balanceMicros,
				1000,
			)
			const denied = yield* billing
				.reserve(call, { source: "other" }, tokens(1))
				.pipe(Effect.flip)
			assert.equal(denied._tag, "SpendingBlocked")
			if (denied._tag === "SpendingBlocked")
				assert.equal(denied.reason, "credits")
			yield* billing.record(first.id, tokens(500))
			yield* billing.record(first.id, tokens(500))
			assert.equal(
				(yield* billing.credits(call.organizationId)).balanceMicros,
				500,
			)
			const second = yield* billing.reserve(
				call,
				{ source: "other" },
				tokens(500),
			)
			const held = yield* billing
				.reserve(call, { source: "other" }, tokens(1))
				.pipe(Effect.flip)
			assert.equal(held._tag, "SpendingBlocked")
			yield* billing.record(second.id, tokens(500))
			assert.equal(
				(yield* billing.credits(call.organizationId)).balanceMicros,
				0,
			)
		}).pipe(
			Effect.scoped,
			Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
		),
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
		}).pipe(
			Effect.scoped,
			Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
		),
	{ timeout: 60000 },
)

it.live(
	"a zero estimate stays known when usage is unknown",
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
		}).pipe(
			Effect.scoped,
			Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
		),
	{ timeout: 60000 },
)
