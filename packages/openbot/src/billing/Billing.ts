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
	readonly chatId?: string
	readonly turnId?: string
	readonly botId?: string
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

/** A stored price, with its tiers and periods. */
export interface Price {
	readonly id: string
	readonly schedule: BillingApi.PriceSchedule
}

/**
 * The cost of the tokens at some rates, in micro-USD, rounded up. Each rate is
 * micro-USD for one million tokens. BigInt keeps the products exact before the division.
 */
export const costOf = (tokens: Tokens, rates: BillingApi.Rates): number => {
	const total =
		BigInt(tokens.inputUncached) * BigInt(rates.inputUncached) +
		BigInt(tokens.inputCacheRead) * BigInt(rates.inputCacheRead) +
		BigInt(tokens.inputCacheWrite) * BigInt(rates.inputCacheWrite) +
		BigInt(tokens.outputText) * BigInt(rates.output) +
		BigInt(tokens.outputReasoning) *
			BigInt(rates.outputReasoning ?? rates.output)
	const million = 1_000_000n
	return Number((total + million - 1n) / million)
}

const weekdays: ReadonlyArray<BillingApi.Weekday> = [
	"sun",
	"mon",
	"tue",
	"wed",
	"thu",
	"fri",
	"sat",
]
const minutesOf = (time: string) =>
	Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))

/** The day of the week and the minute of the day of a time in a time zone. */
const localTime = (at: number, timeZone: string) => {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(at)
	const part = (type: string) =>
		parts.find((part) => part.type === type)?.value ?? ""
	return {
		day: weekdays.indexOf(part("weekday").toLowerCase() as BillingApi.Weekday),
		minute: Number(part("hour")) * 60 + Number(part("minute")),
	}
}

/** Whether a window holds a local time. A window past midnight belongs to the day it starts. */
const holds = (
	window: BillingApi.TimeWindow,
	local: { readonly day: number; readonly minute: number },
) => {
	const start = minutesOf(window.start)
	const end = minutesOf(window.end)
	const on = (day: number) =>
		window.days === undefined || window.days.includes(weekdays[(day + 7) % 7]!)
	return start < end
		? local.minute >= start && local.minute < end && on(local.day)
		: (local.minute >= start && on(local.day)) ||
				(local.minute < end && on(local.day - 1))
}

/**
 * The rates of one call. The first period with a window that holds the start of
 * the call gives the tiers. Then the first tier that the input tokens fit gives the rates.
 */
export const ratesOf = (
	schedule: BillingApi.PriceSchedule,
	tokens: Tokens,
	startedAt: number,
): BillingApi.Rates => {
	const local = localTime(startedAt, schedule.timeZone)
	const tiers =
		schedule.periods.find((period) =>
			period.windows.some((window) => holds(window, local)),
		)?.tiers ?? schedule.tiers
	const input =
		tokens.inputUncached + tokens.inputCacheRead + tokens.inputCacheWrite
	// The contract makes the last tier open, so a tier always fits.
	return tiers.find(
		(tier) => tier.upToInputTokens === null || input <= tier.upToInputTokens,
	)!
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
			/** The time that the call started. It chooses the period of the price. */
			startedAt: number,
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
		/**
		 * What all model calls with this `botId` cost since a time, in every organization.
		 * The memory Bot of a shared Bot works in many organizations, and one budget covers all of them.
		 */
		readonly botSpend: (
			botId: string,
			since: number,
		) => Effect.Effect<number, BillingStorageError>
		/** What the model calls of some Chats of an organization cost since a time. */
		readonly chatSpend: (
			organizationId: string,
			chats: ReadonlyArray<string>,
			since: number,
		) => Effect.Effect<number, BillingStorageError>
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
