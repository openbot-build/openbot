import { Model } from "@openbot-build/core"
import { BillingApi } from "@openbot-build/api"
import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import {
	Array as Arr,
	Clock,
	Context,
	Effect,
	Layer,
	Record as Rec,
	Redacted,
} from "effect"
import { type Attribution, Billing, type Call } from "../src/billing/Billing.ts"
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

// The database is real, so the test uses real time.
it.live(
	"a call pays the price at its start, also when a newer price is in the cache",
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
			const startedEarly = yield* Clock.currentTimeMillis
			yield* Effect.sleep("5 millis")
			yield* billing.setPrice(call.providerId, priceOf(2_000_000), "root")
			yield* Effect.sleep("5 millis")
			// This call puts the new price in the cache.
			yield* billing.record(
				call,
				{ ...attribution, turnId: "late" },
				tokens,
				yield* Clock.currentTimeMillis,
			)
			// This call started before the new price, so the old price applies.
			yield* billing.record(
				call,
				{ ...attribution, turnId: "early" },
				tokens,
				startedEarly,
			)

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
