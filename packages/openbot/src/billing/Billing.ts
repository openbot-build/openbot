// The helpers here take plain data. A pipeable form does not help.
// @effect-diagnostics missingPipeableSignature:off
import type { BillingApi } from "@openbot-build/api"
import { Context, Data, DateTime, type Effect } from "effect"
import type { Response } from "effect/ai"

/** The provider and model of one model call, and who pays for the key. */
export interface Call {
	readonly organizationId: string
	readonly providerId: string
	readonly providerOwner: "platform" | "organization"
	readonly modelId: string
}

/** Who and what made a model call. Each part is missing when the call has none. */
export interface Attribution {
	readonly source: BillingApi.UsageSource
	readonly sessionId?: string
	readonly turnId?: string
	readonly agentId?: string
	readonly userId?: string
	readonly tokenId?: string
}

/** The token counts of one model call, split by price. */
export interface Tokens {
	readonly inputUncached: number
	readonly inputCacheRead: number
	readonly inputCacheWrite: number
	readonly outputText: number
	readonly outputReasoning: number
}

const count = (value: number | undefined) =>
	value === undefined || !Number.isFinite(value) ? 0 : Math.max(0, value)

/**
 * The token counts of a provider response. Providers fill different fields, so
 * a missing part is the total less the parts that are known.
 */
export const tokensOf = (usage: Response.Usage): Tokens => {
	const inputCacheRead = count(usage.inputTokens.cacheRead)
	const inputCacheWrite = count(usage.inputTokens.cacheWrite)
	const outputReasoning = count(usage.outputTokens.reasoning)
	return {
		inputUncached:
			usage.inputTokens.uncached === undefined
				? Math.max(
						0,
						count(usage.inputTokens.total) - inputCacheRead - inputCacheWrite,
					)
				: count(usage.inputTokens.uncached),
		inputCacheRead,
		inputCacheWrite,
		outputText:
			usage.outputTokens.text === undefined
				? Math.max(0, count(usage.outputTokens.total) - outputReasoning)
				: count(usage.outputTokens.text),
		outputReasoning,
	}
}

/** The key of the price of one model at one provider. */
export const priceKey = (providerId: string, modelId: string) =>
	JSON.stringify([providerId, modelId])

/** A stored price. Each value is micro-USD for one million tokens. */
export interface Price {
	readonly id: string
	readonly inputUncached: number
	readonly inputCacheRead: number
	readonly inputCacheWrite: number
	readonly output: number
	readonly outputReasoning: number | null
}

/**
 * The cost of the tokens in micro-USD, rounded up. BigInt keeps the products
 * exact before the division.
 */
export const costOf = (tokens: Tokens, price: Price): number => {
	const total =
		BigInt(tokens.inputUncached) * BigInt(price.inputUncached) +
		BigInt(tokens.inputCacheRead) * BigInt(price.inputCacheRead) +
		BigInt(tokens.inputCacheWrite) * BigInt(price.inputCacheWrite) +
		BigInt(tokens.outputText) * BigInt(price.output) +
		BigInt(tokens.outputReasoning) *
			BigInt(price.outputReasoning ?? price.output)
	const million = 1_000_000n
	return Number((total + million - 1n) / million)
}

/** The start of the current day or month in UTC, in milliseconds. */
export const periodStart = (
	period: BillingApi.BudgetPeriod,
	now: number,
): number => {
	const day = DateTime.startOf(DateTime.makeUnsafe(now), "day")
	return DateTime.toEpochMillis(
		period === "day" ? day : DateTime.startOf(day, "month"),
	)
}

/** A hard budget, or the credits, do not allow another model call now. */
export class SpendingBlocked extends Data.TaggedError("SpendingBlocked")<{
	readonly reason: "budget" | "credits"
	/** The budget that is spent. Missing for credits. */
	readonly budgetId?: string
	readonly message: string
}> {}

/** OpenBot cannot read or write the billing tables now. */
export class BillingStorageError extends Data.TaggedError(
	"BillingStorageError",
)<{ readonly cause: unknown }> {}

/** The organization does not exist. */
export class OrganizationMissing extends Data.TaggedError(
	"OrganizationMissing",
)<{ readonly organizationId: string }> {}

export interface Range {
	readonly from: number
	readonly to: number
}

/** Usage, prices, budgets and credits. All money is in micro-USD. */
export class Billing extends Context.Service<
	Billing,
	{
		/** Fails when a hard budget is spent, or when credits are on and none are left. */
		readonly check: (
			call: Call,
			attribution: Attribution,
		) => Effect.Effect<void, SpendingBlocked | BillingStorageError>
		/** Adds the usage of one finished model call, and takes its cost from the credits when they apply. */
		readonly record: (
			call: Call,
			attribution: Attribution,
			tokens: Tokens,
		) => Effect.Effect<void, BillingStorageError>
		readonly prices: (
			providerId: string,
		) => Effect.Effect<
			ReadonlyArray<BillingApi.ModelPrice>,
			BillingStorageError
		>
		readonly setPrice: (
			providerId: string,
			input: BillingApi.SetModelPriceRequest,
			createdBy: string,
		) => Effect.Effect<BillingApi.ModelPrice, BillingStorageError>
		/** The current price of each model of each provider, keyed by `provider` and `model`. */
		readonly currentPrices: (
			providerIds: ReadonlyArray<string>,
		) => Effect.Effect<
			ReadonlyMap<string, BillingApi.ModelPrice>,
			BillingStorageError
		>
		readonly summary: (
			organizationId: string,
			range: Range,
			groupBy: BillingApi.UsageGroupBy,
		) => Effect.Effect<BillingApi.UsageSummary, BillingStorageError>
		readonly events: (
			organizationId: string,
			range: Range,
			page: { readonly after?: string; readonly limit: number },
		) => Effect.Effect<
			{
				readonly items: ReadonlyArray<BillingApi.UsageEvent>
				readonly next: string | null
			},
			BillingStorageError
		>
		readonly credits: (
			organizationId: string,
		) => Effect.Effect<
			BillingApi.Credits,
			BillingStorageError | OrganizationMissing
		>
		readonly setCreditsEnabled: (
			organizationId: string,
			enabled: boolean,
		) => Effect.Effect<
			BillingApi.Credits,
			BillingStorageError | OrganizationMissing
		>
		readonly grantCredits: (
			organizationId: string,
			input: { readonly amountMicros: number; readonly note: string },
			createdBy: string,
		) => Effect.Effect<
			BillingApi.CreditGrant,
			BillingStorageError | OrganizationMissing
		>
		readonly budgets: (
			organizationId: string,
		) => Effect.Effect<ReadonlyArray<BillingApi.Budget>, BillingStorageError>
		readonly budget: (
			organizationId: string,
			id: string,
		) => Effect.Effect<
			BillingApi.Budget,
			BillingStorageError | BillingApi.BudgetNotFound
		>
		readonly createBudget: (
			organizationId: string,
			input: BillingApi.CreateBudgetRequest,
		) => Effect.Effect<
			BillingApi.Budget,
			BillingStorageError | BillingApi.BudgetConflict | BillingApi.BudgetInvalid
		>
		readonly updateBudget: (
			organizationId: string,
			id: string,
			input: BillingApi.UpdateBudgetRequest,
		) => Effect.Effect<
			BillingApi.Budget,
			| BillingStorageError
			| BillingApi.BudgetNotFound
			| BillingApi.BudgetConflict
		>
		readonly deleteBudget: (
			organizationId: string,
			id: string,
		) => Effect.Effect<void, BillingStorageError | BillingApi.BudgetNotFound>
	}
>()("@openbot-build/openbot/billing/Billing") {}
