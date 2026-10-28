import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Chat, Item, Model } from "@openbot-build/core"
import { Bots } from "@openbot-build/domain"
import {
	Array as Arr,
	Clock,
	Console,
	Effect,
	Layer,
	Redacted,
	Runtime,
	Schema,
	String as Str,
} from "effect"
import { Billing, type Call } from "../src/billing/Billing.ts"
import * as BillingPostgres from "../src/billing/BillingPostgres.ts"
import * as BotMemories from "../src/bots/BotMemories.ts"
import * as BotRecords from "../src/bots/BotRecords.ts"
import * as MemoryLogs from "../src/bots/MemoryLogs.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Audience from "../src/plugins/memory/Audience.ts"
import * as Memory from "../src/plugins/memory/BotMemory.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as PostgresTest from "./PostgresTest.ts"

/** Run this file to check two paper claims against the real PostgreSQL services. */
const memoryEvidence = Effect.gen(function* () {
	const memories = yield* BotMemories.BotMemories
	const home = {
		organizationId: "paper-org",
		bot: Bots.BotId.make("paper-bot"),
	}
	const evidence = Arr.map(["Ana", "Bob"], (author): Memory.Evidence => ({
		source: { chat: Chat.Id.make("group-chat"), item: Item.Id.make(author) },
		role: "user",
		outside: false,
		author,
		organizationId: home.organizationId,
		audience: Audience.channel("group"),
		channel: "group",
		text: author + " likes tea.",
	}))
	const operations: ReadonlyArray<Memory.Operation> = [
		...Arr.map(evidence, (source): Memory.Operation => ({
			_tag: "AddFact",
			ref: source.author,
			content: source.text,
			topics: [],
			sources: [source.source],
		})),
		{
			_tag: "AddObservation",
			ref: "both",
			content: "Ana and Bob like tea.",
			topics: [],
			supports: ["Ana", "Bob"],
			confidence: 1,
		},
	]
	const expectedIds = ["source-ana", "source-bob", "derived"]
	const applied = yield* memories.change(home, (pool) => {
		const result = Memory.apply({
			pool,
			evidence,
			operations,
			now: 1,
			ids: expectedIds,
		})
		return Effect.succeed({ ...result, by: "memory_bot" as const, result })
	})
	const storedIds = Arr.map(yield* memories.pool(home), (entry) => entry.id)
	const hasExpectedIds = (ids: ReadonlyArray<string>) =>
		ids.length === expectedIds.length &&
		Arr.every(expectedIds, (id) => ids.includes(id))
	const viewers: ReadonlyArray<Audience.Viewer> = [
		{ organizationId: home.organizationId, person: "Ana" },
		{ organizationId: home.organizationId, person: "Bob" },
		{ organizationId: home.organizationId, person: "Carol" },
		{ organizationId: home.organizationId, channel: "group" },
		{ organizationId: home.organizationId, channel: "other-group" },
		{ organizationId: "other-org", person: "Ana" },
	]
	const views = yield* Effect.forEach(viewers, (viewer) =>
		Effect.map(memories.view(home, viewer), (view) => {
			const ids = Arr.map(view.entries, (entry) => entry.id)
			return {
				viewer,
				ids,
				passed:
					!ids.includes("derived") ||
					(ids.includes("source-ana") && ids.includes("source-bob")),
			}
		}),
	)
	const setupChecks = {
		allOperationsAccepted: applied.rejected === 0,
		allEntriesStored: hasExpectedIds(storedIds),
		groupReadsAllEntries: Arr.some(
			views,
			(view) => view.viewer.channel === "group" && hasExpectedIds(view.ids),
		),
	}
	const setupPassed =
		setupChecks.allOperationsAccepted &&
		setupChecks.allEntriesStored &&
		setupChecks.groupReadsAllEntries
	const privacyPassed = setupPassed
		? Arr.every(views, (view) => view.passed)
		: null
	return {
		paper: "06-memory-information-flow",
		check: "A reader of a derived entry can read every source.",
		setupChecks,
		setupPassed,
		privacyPassed,
		passed: setupPassed && privacyPassed === true,
		input: { evidence, operations },
		observed: {
			rejected: applied.rejected,
			entries: applied.entries,
			storedIds,
			views,
		},
	}
})

const budgetEvidence = Effect.gen(function* () {
	const billing = yield* Billing
	const sql = yield* PgClient.PgClient
	const call: Call = {
		organizationId: "paper-org",
		providerId: "paper-provider",
		providerOwner: "organization",
		modelId: "paper-model",
	}
	const tokens = {
		inputUncached: 1000,
		inputCacheRead: 0,
		inputCacheWrite: 0,
		outputText: 0,
		outputReasoning: 0,
	}
	const limitMicros = 1000
	yield* sql`insert into openbot_model_providers (id, owner_kind, owner_id, kind, name, api_key, version, created_at, updated_at) values (${call.providerId}, 'organization', ${call.organizationId}, 'openai-compat', 'Paper provider', 'test key', 1, 0, 0)`
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
		"paper-owner",
	)
	const budget = yield* billing.createBudget(call.organizationId, {
		scope: "organization",
		period: "day",
		mode: "hard",
		limitMicros,
	})
	const snapshot = Effect.gen(function* () {
		const range = { from: 0, to: (yield* Clock.currentTimeMillis) + 1 }
		const events = yield* billing.events(call.organizationId, range, {
			limit: 10,
		})
		const summary = yield* billing.summary(call.organizationId, range, "source")
		return {
			costMicros: summary.total.costMicros,
			pendingCalls: summary.total.pendingCalls,
			unknownCalls: summary.total.unknownCalls,
			holdsMicros: Arr.reduce(
				events.items,
				0,
				(sum, event) => sum + event.reservedMicros,
			),
		}
	})
	const first = yield* billing.reserve(call, { source: "other" }, tokens)
	const held = yield* snapshot
	const blockedAtCap = yield* billing
		.reserve(call, { source: "other" }, tokens)
		.pipe(
			Effect.as(false),
			Effect.catchTag("SpendingBlocked", (error) =>
				Effect.succeed(
					error.reason === "budget" && error.budgetId === budget.id,
				),
			),
		)
	yield* billing.unknown(first.id)
	const unknown = yield* snapshot
	const second = yield* billing
		.reserve(call, { source: "other" }, tokens)
		.pipe(
			Effect.catchTag("SpendingBlocked", (error) =>
				error.reason === "budget" && error.budgetId === budget.id
					? Effect.void
					: Effect.fail(error),
			),
		)
	if (second !== undefined) yield* billing.record(second.id, tokens)
	const next = yield* snapshot
	yield* billing.record(first.id, tokens)
	const late = yield* snapshot
	yield* billing.record(first.id, tokens)
	const duplicate = yield* snapshot
	const setupChecks = {
		initialHoldFillsCap:
			held.holdsMicros === limitMicros &&
			held.pendingCalls === 1 &&
			held.costMicros === 0,
		blockedAtCap,
		unknownCallRecorded:
			unknown.unknownCalls === 1 && unknown.pendingCalls === 0,
		confirmedCostsRecorded:
			late.costMicros === (second === undefined ? 1000 : 2000),
	}
	const setupPassed =
		setupChecks.initialHoldFillsCap &&
		setupChecks.blockedAtCap &&
		setupChecks.unknownCallRecorded &&
		setupChecks.confirmedCostsRecorded
	const ruleChecks = {
		unknownHoldKept: unknown.holdsMicros === limitMicros,
		secondCallBlocked: second === undefined,
		confirmedCostWithinCap: late.costMicros <= limitMicros,
		duplicateReceiptNotCharged: duplicate.costMicros === late.costMicros,
	}
	const capPassed = setupPassed
		? ruleChecks.unknownHoldKept &&
			ruleChecks.secondCallBlocked &&
			ruleChecks.confirmedCostWithinCap &&
			ruleChecks.duplicateReceiptNotCharged
		: null
	return {
		paper: "12-budget-scheduling",
		check:
			"Unknown calls keep their holds when each receipt matches its saved estimate.",
		ruleChecks,
		setupChecks,
		setupPassed,
		capPassed,
		passed: setupPassed && capPassed === true,
		input: {
			limitMicros,
			tokens,
			inputPricePerMillionMicros: 1_000_000,
			receiptMatchesEstimate: true,
		},
		observed: {
			secondCallAdmitted: second !== undefined,
			held,
			unknown,
			next,
			late,
			duplicate,
			duplicateReceiptPassed: duplicate.costMicros === late.costMicros,
		},
	}
})

class PaperChecksFailed extends Schema.TaggedError<
	PaperChecksFailed,
	{ readonly brand: unique symbol }
>()("PaperChecksFailed", {}) {
	// The JSON report already gives every failed check. Keep stdout valid JSON.
	override readonly [Runtime.errorReported] = false
}

const main = Effect.gen(function* () {
	const database = yield* PostgresTest.start
	const databaseLayer = DatabasePostgres.layer({
		databaseUrl: Redacted.make(database.url),
	})
	yield* DatabasePostgres.migrate.pipe(Effect.provide(databaseLayer))
	const services = Layer.mergeAll(
		BotMemories.layer.pipe(
			Layer.provide(Layer.mergeAll(BotRecords.layer, MemoryLogs.layer)),
		),
		BillingPostgres.layer,
	).pipe(
		Layer.provide(Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11")))),
		Layer.provideMerge(databaseLayer),
	)
	const checks = yield* Effect.gen(function* () {
		const sql = yield* PgClient.PgClient
		yield* sql`insert into openbot_organizations (id, name, status, created_at) values ('paper-org', 'Paper tests', 'active', 0)`
		return [yield* memoryEvidence, yield* budgetEvidence]
	}).pipe(Effect.provide(services))
	const passed = Arr.every(checks, (check) => check.passed)
	yield* Console.log(
		yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
			suite: "Paper checks against PostgreSQL services",
			passed,
			checks,
		}),
	)
	if (process.argv.includes("--strict") && !passed)
		return yield* PaperChecksFailed.make({})
})

main.pipe(
	Effect.scoped,
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
)
