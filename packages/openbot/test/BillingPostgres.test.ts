import { Model } from "@openbot-build/core"
import { BillingApi } from "@openbot-build/api"
import { Execution } from "@openbot-build/domain"
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
	Option,
	Record as Rec,
	Redacted,
	Schema,
	String as Str,
} from "effect"
import {
	type Attribution,
	Billing,
	BillingStorageError,
	type Call,
	SpendingBlocked,
} from "../src/billing/Billing.ts"
import * as Store from "../src/execution/Store.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as BillingPostgres from "../src/billing/BillingPostgres.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as PostgresTest from "./PostgresTest.ts"

const call: Call = {
	organizationId: "org_prices",
	providerId: "provider_prices",
	providerOwner: "organization",
	modelId: "model_prices",
}
const attribution: Attribution = { source: "other" }
/** 1000 uncached input tokens and nothing else. */
const tokens = {
	inputUncached: 1000,
	inputCacheRead: 0,
	inputCacheWrite: 0,
	outputText: 0,
	outputReasoning: 0,
}
/** A price of one tier. The call above costs `inputUncached / 1000` micro-USD. */
const priceOf = (inputUncached: number): BillingApi.SetModelPriceRequest => ({
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
})

it.live(
	"reservations share one budget and confirmed usage settles once",
	() =>
		Effect.gen(function* () {
			const database = yield* PostgresTest.start
			const databaseLayer = DatabasePostgres.layer({
				databaseUrl: Redacted.make(database.url),
			})
			yield* DatabasePostgres.migrate.pipe(Effect.provide(databaseLayer))
			const services = yield* Layer.build(
				Layer.mergeAll(BillingPostgres.layer, Store.layer).pipe(
					Layer.provide(
						Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
					),
					Layer.provideMerge(databaseLayer),
				),
			)
			const billing = Context.get(services, Billing)
			const sql = Context.get(services, PgClient.PgClient)
			const paying = { ...call, providerOwner: "platform" } as const
			yield* sql`INSERT INTO openbot_organizations (id, name, status, created_at) VALUES (${call.organizationId}, 'Usage', 'active', 0)`
			yield* sql`INSERT INTO openbot_model_providers (id, owner_kind, owner_id, kind, name, api_key, version, created_at, updated_at) VALUES (${call.providerId}, 'platform', 'platform', 'openai-compat', 'Prices', 'test key', 1, 0, 0)`
			yield* billing.setPrice(call.providerId, priceOf(1_000_000), "root")
			yield* billing.setCreditsEnabled(call.organizationId, true)
			yield* billing.grantCredits(
				call.organizationId,
				{ amountMicros: 5000, note: "Test credits" },
				"root",
			)
			yield* billing.createBudget(call.organizationId, {
				scope: "organization",
				period: "day",
				mode: "hard",
				limitMicros: 1000,
			})
			const competing = yield* Effect.forEach(
				[0, 1],
				() => billing.reserve(paying, attribution, tokens).pipe(Effect.exit),
				{ concurrency: 2 },
			)
			const accepted = Arr.filter(competing, Exit.isSuccess)
			const denied = Arr.filter(competing, Exit.isFailure)
			assert.strictEqual(accepted.length, 1)
			assert.strictEqual(denied.length, 1)
			const id = accepted[0]!.value.id
			yield* billing.unknown(id)
			const before = yield* billing.events(
				call.organizationId,
				{ from: 0, to: (yield* Clock.currentTimeMillis) + 1 },
				{ limit: 10 },
			)
			assert.strictEqual(before.items[0]?.status, "unknown")
			assert.strictEqual(before.items[0]?.costMicros, null)
			assert.strictEqual(before.items[0]?.inputUncached, null)
			assert.strictEqual(before.items[0]?.reservedMicros, 1000)
			assert.strictEqual(before.items[0]?.estimatedMicros, 1000)
			// A confirmed zero receipt frees the hold without a charge.
			const zero = { ...tokens, inputUncached: 0 }
			yield* billing.record(id, zero)
			const store = Context.get(services, Store.Store)
			const actor = {
				kind: "member",
				organizationId: call.organizationId,
				userId: "user",
			} as const
			const receipt = yield* store.submit(
				"usage",
				Execution.CommandKey.make("start"),
				{
					workflow: "test",
					resource: { kind: "Chat", id: "usage" },
					identity: { owner: actor, actor },
					input: null,
				},
			)
			const fence = yield* store.takeOver({
				namespace: "usage",
				id: receipt.executionId,
			})
			const pending = yield* store.readAttempt(fence, "model", null)
			yield* store.sending(fence, pending.id)
			const identity = {
				id: pending.id,
				executionId: fence.id,
				generation: fence.generation,
			}
			const next = yield* billing.reserve(paying, attribution, tokens, identity)
			assert.deepStrictEqual(
				yield* billing.reserve(paying, attribution, tokens, identity),
				next,
			)
			yield* Effect.forEach([0, 1, 2], () => billing.record(next.id, tokens), {
				concurrency: 3,
			})
			yield* store.transition(fence, "completed")
			assert.isTrue(yield* billing.releaseExecution(identity))
			const [credits] = yield* sql<{
				readonly balanceMicros: number
			}>`select balance_micros as "balanceMicros" from openbot_organization_credits where organization_id = ${call.organizationId}`
			assert.strictEqual(Number(credits?.balanceMicros), 4000)
			const summary = yield* billing.summary(
				call.organizationId,
				{ from: 0, to: (yield* Clock.currentTimeMillis) + 1 },
				"source",
			)
			assert.strictEqual(summary.total.calls, 2)
			assert.strictEqual(summary.total.unknownCalls, 0)
			assert.strictEqual(summary.total.pendingCalls, 0)
			assert.strictEqual(summary.total.costMicros, 1000)
			const blocked = yield* billing
				.reserve(paying, attribution, tokens)
				.pipe(Effect.flip)
			assert.isTrue(Schema.is(SpendingBlocked)(blocked))
			// A duplicate zero receipt cannot change the total.
			yield* billing.record(id, zero)
			yield* billing.record(id, zero)
			const final = yield* billing.summary(
				call.organizationId,
				{ from: 0, to: (yield* Clock.currentTimeMillis) + 1 },
				"source",
			)
			assert.strictEqual(final.total.calls, 2)
			assert.strictEqual(final.total.unknownCalls, 0)
			assert.strictEqual(final.total.costMicros, 1000)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	{ timeout: 60000 },
)

it.live(
	"takeover keeps old holds and late usage commits with its result",
	() =>
		Effect.gen(function* () {
			const database = yield* PostgresTest.start
			const databaseLayer = DatabasePostgres.layer({
				databaseUrl: Redacted.make(database.url),
			})
			yield* DatabasePostgres.migrate.pipe(Effect.provide(databaseLayer))
			const services = yield* Layer.build(
				Layer.mergeAll(BillingPostgres.layer, Store.layer).pipe(
					Layer.provide(
						Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
					),
					Layer.provideMerge(databaseLayer),
				),
			)
			const billing = Context.get(services, Billing)
			const store = Context.get(services, Store.Store)
			const sql = Context.get(services, PgClient.PgClient)
			const paying = { ...call, providerOwner: "platform" } as const
			yield* sql`insert into openbot_organizations (id, name, status, created_at) values (${call.organizationId}, 'Usage', 'active', 0)`
			yield* sql`insert into openbot_model_providers (id, owner_kind, owner_id, kind, name, api_key, version, created_at, updated_at) values (${call.providerId}, 'platform', 'platform', 'openai-compat', 'Prices', 'test key', 1, 0, 0)`
			yield* billing.setPrice(call.providerId, priceOf(1_000_000), "root")
			yield* billing.setCreditsEnabled(call.organizationId, true)
			yield* billing.grantCredits(
				call.organizationId,
				{ amountMicros: 5000, note: "Test credits" },
				"root",
			)
			const actor = {
				kind: "member",
				organizationId: call.organizationId,
				userId: "user",
			} as const
			const receipt = yield* store.submit(
				"usage-owner",
				Execution.CommandKey.make("start"),
				{
					workflow: "test",
					resource: { kind: "Chat", id: "usage" },
					identity: { owner: actor, actor },
					input: null,
				},
			)
			const key = { namespace: "usage-owner", id: receipt.executionId }
			const first = yield* store.takeOver(key)
			const start = (fence: Store.Fence, step: string) =>
				Effect.gen(function* () {
					const attempt = yield* store.readAttempt(fence, step, null)
					yield* store.sending(fence, attempt.id)
					return {
						id: attempt.id,
						executionId: fence.id,
						generation: fence.generation,
					}
				})
			const firstCall = yield* start(first, "model")
			yield* billing.reserve(paying, attribution, tokens, firstCall)
			// This old call has an intent but has not yet checked the budget.
			const unsent = yield* start(first, "helper")
			const second = yield* store.takeOver(key)
			const currentCall = yield* start(second, "model")
			yield* billing.reserve(paying, attribution, tokens, currentCall)
			const state = (id: Execution.CallId) =>
				sql<{
					status: string
					reserved: number
				}>`select status, reserved_micros::int as reserved from openbot_usage_events where id = ${id}`
			assert.isFalse(yield* billing.releaseExecution(firstCall))
			assert.deepEqual((yield* state(firstCall.id))[0], {
				status: "pending",
				reserved: 1000,
			})
			assert.isTrue(yield* billing.releaseExecution(currentCall))
			assert.deepEqual((yield* state(firstCall.id))[0], {
				status: "unknown",
				reserved: 1000,
			})
			assert.deepEqual((yield* state(currentCall.id))[0], {
				status: "pending",
				reserved: 1000,
			})
			const stale = yield* billing
				.reserve(paying, attribution, tokens, unsent)
				.pipe(Effect.flip)
			assert.isTrue(Schema.is(BillingStorageError)(stale))
			if (Schema.is(BillingStorageError)(stale))
				assert.isUndefined(stale.retryable)
			assert.equal((yield* state(unsent.id)).length, 0)
			const wrongOwner = yield* billing
				.reserve(
					{ ...paying, organizationId: "other" },
					attribution,
					tokens,
					currentCall,
				)
				.pipe(Effect.flip)
			assert.isTrue(Schema.is(BillingStorageError)(wrongOwner))
			// A failed ledger write rolls back the saved late result too.
			yield* sql`create function fail_usage() returns trigger language plpgsql as $$ begin if NEW.status = 'confirmed' then raise exception 'usage write failed'; end if; return NEW; end; $$`
			yield* sql`create trigger fail_usage before update on openbot_usage_events for each row execute function fail_usage()`
			const settle = store.finishCall(
				first,
				firstCall.id,
				{ saved: true },
				[],
				billing.record(firstCall.id, tokens),
			)
			const failure = yield* settle.pipe(Effect.flip)
			assert.isTrue(Schema.is(BillingStorageError)(failure))
			if (Schema.is(BillingStorageError)(failure))
				assert.isTrue(failure.retryable)
			assert.equal(
				Arr.findFirst(
					yield* store.calls(key),
					(item) => item.id === firstCall.id,
				).pipe(Option.getOrThrow).status,
				"outcome_unknown",
			)
			assert.deepEqual((yield* state(firstCall.id))[0], {
				status: "unknown",
				reserved: 1000,
			})
			yield* sql`drop trigger fail_usage on openbot_usage_events`
			yield* sql`drop function fail_usage()`
			const sequence = (yield* store.get(key)).sequence
			assert.isFalse(yield* settle)
			assert.isFalse(yield* settle)
			assert.equal((yield* store.get(key)).sequence, sequence + 1)
			assert.deepEqual(
				Arr.map(yield* store.events(key, sequence), (event) => event.body._tag),
				["CallRecorded"],
			)
			assert.deepEqual((yield* state(firstCall.id))[0], {
				status: "confirmed",
				reserved: 0,
			})
			const [credits] = yield* sql<{
				balance: number
			}>`select balance_micros::int as balance from openbot_organization_credits where organization_id = ${call.organizationId}`
			assert.equal(credits?.balance, 4000)
			const endedPending = yield* start(second, "helper")
			yield* billing.reserve(paying, attribution, tokens, endedPending)
			yield* sql`update openbot_usage_events set status = 'unknown' where id = ${currentCall.id}`
			yield* store.transition(second, "completed")
			assert.isTrue(yield* billing.releaseExecution(currentCall))
			assert.deepEqual((yield* state(currentCall.id))[0], {
				status: "unknown",
				reserved: 1000,
			})
			assert.isTrue(yield* billing.releaseExecution(currentCall))
			assert.deepEqual((yield* state(currentCall.id))[0], {
				status: "unknown",
				reserved: 1000,
			})
			assert.deepEqual((yield* state(firstCall.id))[0], {
				status: "confirmed",
				reserved: 0,
			})
			assert.deepEqual((yield* state(endedPending.id))[0], {
				status: "unknown",
				reserved: 1000,
			})
			// The ended call can still settle a late receipt once.
			yield* billing.record(currentCall.id, tokens)
			yield* billing.record(currentCall.id, tokens)
			const [late] = yield* sql<{
				balance: number
				estimate: number
			}>`select c.balance_micros::int as balance, u.estimated_micros::int as estimate from openbot_organization_credits c join openbot_usage_events u on u.organization_id = c.organization_id where u.id = ${currentCall.id}`
			assert.equal(late?.balance, 3000)
			assert.equal(late?.estimate, 1000)
			const ended = yield* billing
				.reserve(paying, attribution, tokens, currentCall)
				.pipe(Effect.flip)
			assert.isTrue(Schema.is(BillingStorageError)(ended))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	{ timeout: 60000 },
)

// The database is real, so the test uses real time.
it.live(
	"each node uses the current price and a call keeps its price after provider removal",
	() =>
		Effect.gen(function* () {
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
			yield* sql`INSERT INTO openbot_model_providers (id, owner_kind, owner_id, kind, name, api_key, version, created_at, updated_at) VALUES (${call.providerId}, 'organization', ${call.organizationId}, 'openai-compat', 'Prices', 'sk-prices', 1, 0, 0)`

			yield* billing.setPrice(call.providerId, priceOf(1_000_000), "root")
			yield* Effect.sleep("5 millis")
			const early = yield* billing.reserve(
				call,
				{ ...attribution, turnId: "early" },
				tokens,
			)
			yield* Effect.sleep("5 millis")
			const other = Context.get(
				yield* Layer.build(
					BillingPostgres.layer.pipe(Layer.provide(databaseLayer)),
				),
				Billing,
			)
			yield* other.setPrice(call.providerId, priceOf(2_000_000), "root")
			// Two changes in one millisecond still have a fixed order.
			yield* sql`update openbot_model_prices set effective_from = 0 where provider_id = ${call.providerId}`
			yield* Effect.sleep("5 millis")
			// The first node must see the price set by the second node.
			const late = yield* billing.reserve(
				call,
				{ ...attribution, turnId: "late" },
				tokens,
			)
			// A removed provider must not erase the price of calls already sent.
			yield* sql`delete from openbot_model_providers where id = ${call.providerId}`
			yield* billing.record(late.id, tokens)
			// This call started before the new price, so the old price applies.
			yield* billing.record(early.id, tokens)

			const page = yield* billing.events(
				call.organizationId,
				{ from: 0, to: (yield* Clock.currentTimeMillis) + 1 },
				{ limit: 10 },
			)
			assert.deepStrictEqual(
				Rec.fromEntries(
					Arr.map(page.items, (event) => [
						event.turnId ?? "none",
						event.costMicros,
					]),
				),
				{ late: 2000, early: 1000 },
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	{ timeout: 60000 },
)
