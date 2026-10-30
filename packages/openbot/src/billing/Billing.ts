import { type Billing as BillingApi, Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Context,
	DateTime,
	type Effect,
	type HashMap,
	Option,
	pipe,
	Schema,
	String as Str,
} from "effect"
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

/** A stored price, with its tiers and periods. */
export interface Price {
	readonly id: string
	/** The time that the price took effect, in milliseconds. */
	readonly effectiveFrom: number
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

/** The number of each day of the week, with 0 for Sunday, as `DateTime` gives it. */
const weekdayNumber: Record<BillingApi.Weekday, number> = {
	sun: 0,
	mon: 1,
	tue: 2,
	wed: 3,
	thu: 4,
	fri: 5,
	sat: 6,
}
const minutesOf = (time: string) =>
	Number(Str.slice(0, 2)(time)) * 60 + Number(Str.slice(3, 5)(time))

/** The day of the week and the minute of the day of a time in a time zone. */
const localTime = (at: number, timeZone: string) => {
	const { weekDay, hour, minute } = DateTime.toParts(
		DateTime.makeZonedUnsafe(at, { timeZone }),
	)
	return { day: weekDay, minute: hour * 60 + minute }
}

/** Whether a window holds a local time. A window past midnight belongs to the day it starts. */
const holds = (
	window: BillingApi.TimeWindow,
	local: { readonly day: number; readonly minute: number },
) => {
	const start = minutesOf(window.start)
	const end = minutesOf(window.end)
	const on = (day: number) =>
		window.days === undefined ||
		Arr.some(window.days, (weekday) => weekdayNumber[weekday] === (day + 7) % 7)
	return start < end
		? local.minute >= start && local.minute < end && on(local.day)
		: (local.minute >= start && on(local.day)) ||
				(local.minute < end && on(local.day - 1))
}

/** The tiers in the first period that holds the start of the call. */
const tiersAt = (schedule: BillingApi.PriceSchedule, startedAt: number) => {
	const local = localTime(startedAt, schedule.timeZone)
	return pipe(
		Arr.findFirst(schedule.periods, (period) =>
			Arr.some(period.windows, (window) => holds(window, local)),
		),
		Option.match({
			onNone: () => schedule.tiers,
			onSome: (period) => period.tiers,
		}),
	)
}

/** No token has a cost in any tier at this time. */
export const isFreeAt = (
	schedule: BillingApi.PriceSchedule,
	startedAt: number,
): boolean =>
	Arr.every(
		tiersAt(schedule, startedAt),
		(rates) =>
			rates.inputUncached === 0 &&
			rates.inputCacheRead === 0 &&
			rates.inputCacheWrite === 0 &&
			rates.output === 0 &&
			(rates.outputReasoning ?? rates.output) === 0,
	)

/**
 * The rates of one call. The first period with a window that holds the start of
 * the call gives the tiers. Then the first tier that the input tokens fit gives the rates.
 */
export const ratesOf = (
	schedule: BillingApi.PriceSchedule,
	tokens: Tokens,
	startedAt: number,
): BillingApi.Rates => {
	const tiers = tiersAt(schedule, startedAt)
	const input =
		tokens.inputUncached + tokens.inputCacheRead + tokens.inputCacheWrite
	// The contract makes the last tier open, so a tier always fits.
	return pipe(
		Arr.findFirst(
			tiers,
			(tier) => tier.upToInputTokens === null || input <= tier.upToInputTokens,
		),
		Option.getOrElse(() => Arr.lastNonEmpty(tiers)),
	)
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
export class SpendingBlocked extends Schema.TaggedError<
	SpendingBlocked,
	{ readonly brand: unique symbol }
>()("SpendingBlocked", {
	reason: Schema.Literals(["budget", "credits"]),
	/** The budget that is spent. Missing for credits. */
	budgetId: Schema.optional(Schema.String),
	message: Schema.String,
}) {}

/** OpenBot cannot read or write the billing tables now. */
export class BillingStorageError extends Schema.TaggedError<
	BillingStorageError,
	{ readonly brand: unique symbol }
>()("BillingStorageError", {
	cause: Schema.Defect(),
	/** Only a database failure may retry a result commit. */
	retryable: Schema.optionalKey(Schema.Boolean),
}) {}

/** The organization does not exist. */
export class OrganizationMissing extends Schema.TaggedError<
	OrganizationMissing,
	{ readonly brand: unique symbol }
>()("OrganizationMissing", { organizationId: Schema.String }) {}

export interface Range {
	readonly from: number
	readonly to: number
}

/** The owner of one durable execution attempt. */
export interface ExecutionOwner {
	readonly executionId: Execution.Id
	readonly generation: number
}
export interface CallIdentity extends ExecutionOwner {
	readonly id: Execution.CallId
}

/** Usage, prices, budgets and credits. All money is in micro-USD. */
export class Billing extends Context.Service<
	Billing,
	{
		/** Reserve an estimate before a provider call. Reuse its ID on a safe retry. */
		readonly reserve: (
			call: Call,
			attribution: Attribution,
			estimate: Tokens,
			identity?: CallIdentity,
		) => Effect.Effect<
			{ readonly id: Execution.CallId; readonly startedAt: number },
			SpendingBlocked | BillingStorageError
		>
		/** Settle confirmed usage once, and release its estimate. */
		readonly record: (
			id: Execution.CallId,
			tokens: Tokens,
		) => Effect.Effect<void, BillingStorageError>
		/** The provider did not confirm usage. Keep the hold until a receipt arrives. */
		readonly unknown: (
			id: Execution.CallId,
		) => Effect.Effect<void, BillingStorageError>
		/** Mark old or ended attempts unknown. Keep their holds. Reject a stale owner. */
		readonly releaseExecution: (
			owner: ExecutionOwner,
		) => Effect.Effect<boolean, BillingStorageError>
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
			HashMap.HashMap<
				readonly [providerId: string, modelId: string],
				BillingApi.ModelPrice
			>,
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
			BillingStorageError | BillingApi.UsageQueryInvalid
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
			input: {
				readonly amountMicros: number
				readonly note: string
				readonly operationKey?: string
			},
			createdBy: string,
		) => Effect.Effect<
			BillingApi.CreditGrant,
			BillingStorageError | OrganizationMissing | BillingApi.CreditConflict
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
