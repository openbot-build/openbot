import { Model, Provider } from "@openbot-build/core"
import { DateTime, Option, Schema } from "effect"
import { TokenId } from "./TokenId.ts"
import * as Execution from "./Execution.ts"
import { Version } from "./Version.ts"

/**
 * An amount of money in micro-USD. One US dollar is 1,000,000 micro-USD.
 * Whole numbers keep sums exact.
 */
export const Micros = Schema.Int
export const NonNegativeMicros = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(0),
)

/**
 * The rates of one price tier. Each value is the cost of one million tokens, in
 * micro-USD. For example, 2500000 is 2.50 US dollars.
 */
export const Rates = Schema.Struct({
	/** Input tokens that the provider did not read from its cache. */
	inputUncached: NonNegativeMicros,
	/** Input tokens that the provider read from its cache. */
	inputCacheRead: NonNegativeMicros,
	/** Input tokens that the provider wrote to its cache. */
	inputCacheWrite: NonNegativeMicros,
	/** Output text and tool calls. */
	output: NonNegativeMicros,
	/** Reasoning tokens. Null means the same price as `output`. */
	outputReasoning: Schema.NullOr(NonNegativeMicros),
})
export type Rates = typeof Rates.Type

/**
 * One tier of a price. A call uses the first tier whose `upToInputTokens` is at
 * least the input tokens of the call. All tokens of the call then cost the rates
 * of that tier. The last tier has no upper limit.
 */
export const PriceTier = Schema.Struct({
	/** The most input tokens of a call in this tier. Null for the last tier. */
	upToInputTokens: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
	...Rates.fields,
})
export type PriceTier = typeof PriceTier.Type
export const PriceTiers = Schema.NonEmptyArray(PriceTier).check(
	Schema.isMaxLength(20),
	Schema.makeFilter((tiers: ReadonlyArray<PriceTier>) => {
		for (const [index, tier] of tiers.entries()) {
			const last = index === tiers.length - 1
			if (last !== (tier.upToInputTokens === null))
				return "Expected only the last tier to have upToInputTokens null"
			const previous = tiers[index - 1]?.upToInputTokens
			if (
				previous != null &&
				tier.upToInputTokens !== null &&
				tier.upToInputTokens <= previous
			)
				return "Expected upToInputTokens to grow from tier to tier"
		}
		return undefined
	}),
)

/** A time of day as `HH:MM`, from `00:00` to `24:00`. */
export const TimeOfDay = Schema.String.check(
	Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/),
)
export const Weekday = Schema.Literals([
	"mon",
	"tue",
	"wed",
	"thu",
	"fri",
	"sat",
	"sun",
])
export type Weekday = typeof Weekday.Type

/**
 * A part of the day in the time zone of the price. When `end` is before `start`,
 * the window goes past midnight. `days` are the days on which the window starts.
 */
export const TimeWindow = Schema.Struct({
	start: TimeOfDay,
	end: TimeOfDay,
	/** Leave it out for every day. */
	days: Schema.optionalKey(
		Schema.Array(Weekday).check(Schema.isMinLength(1), Schema.isMaxLength(7)),
	),
}).check(
	Schema.makeFilter(
		(window: { readonly start: string; readonly end: string }) =>
			window.start === window.end
				? "Expected a window with a different start and end"
				: undefined,
	),
)
export type TimeWindow = typeof TimeWindow.Type

/** Other tiers for some times, such as a lower price at night. */
export const PricePeriod = Schema.Struct({
	/** A short name, such as `off-peak`. */
	name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
	windows: Schema.Array(TimeWindow).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(20),
	),
	tiers: PriceTiers,
})
export type PricePeriod = typeof PricePeriod.Type

/** An IANA time zone, such as `UTC` or `Asia/Shanghai`. */
export const TimeZone = Schema.String.check(
	Schema.isMaxLength(64),
	Schema.makeFilter((value: string) =>
		Option.isSome(DateTime.zoneMakeNamed(value))
			? undefined
			: "Expected an IANA time zone, such as UTC or Asia/Shanghai",
	),
)

/**
 * How a model is priced at one provider. A call uses the first period with a
 * window that holds the start of the call. Without one, it uses `tiers`.
 */
export const PriceSchedule = Schema.Struct({
	/** The time zone of the windows of the periods. */
	timeZone: TimeZone,
	tiers: PriceTiers,
	periods: Schema.Array(PricePeriod).check(Schema.isMaxLength(20)),
})
export type PriceSchedule = typeof PriceSchedule.Type

/** The price of a model at one provider. */
export const ModelPrice = Schema.Struct({
	model: Model.Id,
	...PriceSchedule.fields,
	/** The time from which this price applies. */
	effectiveFrom: Schema.String,
})
export type ModelPrice = typeof ModelPrice.Type
export const SetModelPriceRequest = Schema.Struct({
	model: Model.Id.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
	/** Leave it out for `UTC`. */
	timeZone: Schema.optionalKey(TimeZone),
	tiers: PriceTiers,
	/** Leave it out when the price is the same at all times. */
	periods: Schema.optionalKey(PriceSchedule.fields.periods),
})
export type SetModelPriceRequest = typeof SetModelPriceRequest.Type
/** The current prices of the models of one provider. A model without a price costs 0. */
export const ModelPrices = Schema.Struct({ items: Schema.Array(ModelPrice) })

/** What made a model call. */
export const UsageSource = Schema.Literals([
	/** A model step of a Turn. */
	"turn",
	/** A summary of old messages, so the conversation fits the model. */
	"compaction",
	/** The model that judges Rules. */
	"judge",
	/** The model that learns Bot memory. */
	"bot_memory",
	"other",
])
export type UsageSource = typeof UsageSource.Type

export const UsageStatus = Schema.Literals(["pending", "confirmed", "unknown"])
export type UsageStatus = typeof UsageStatus.Type

/** The tokens and cost of one model call. Missing usage is not zero usage. */
export const UsageEvent = Schema.Struct({
	id: Execution.CallId,
	executionId: Schema.NullOr(Execution.Id),
	status: UsageStatus,
	startedAt: Schema.String,
	/** The amount held while the call runs. An ended call releases it. */
	reservedMicros: NonNegativeMicros,
	/** The saved cost estimate. Null when an old row no longer has it. */
	estimatedMicros: Schema.NullOr(NonNegativeMicros),
	estimatedTokens: Schema.Natural,
	occurredAt: Schema.String,
	source: UsageSource,
	chatId: Schema.NullOr(Schema.String),
	turnId: Schema.NullOr(Schema.String),
	botId: Schema.NullOr(Schema.String),
	userId: Schema.NullOr(Schema.String),
	tokenId: Schema.NullOr(TokenId),
	provider: Provider.Id,
	/** `platform` when the platform paid for the call, `organization` when the organization used its own API key. */
	providerOwner: Schema.Literals(["platform", "organization"]),
	model: Model.Id,
	inputUncached: Schema.NullOr(Schema.Int),
	inputCacheRead: Schema.NullOr(Schema.Int),
	inputCacheWrite: Schema.NullOr(Schema.Int),
	outputText: Schema.NullOr(Schema.Int),
	outputReasoning: Schema.NullOr(Schema.Int),
	/** False when the model had no price. Then the cost is 0. */
	priced: Schema.Boolean,
	costMicros: Schema.NullOr(NonNegativeMicros),
	/** True when the cost was taken from the credits of the organization. */
	charged: Schema.Boolean,
})
export type UsageEvent = typeof UsageEvent.Type

export const UsageTotals = Schema.Struct({
	calls: Schema.Int,
	pendingCalls: Schema.Int,
	unknownCalls: Schema.Int,
	inputUncached: Schema.Int,
	inputCacheRead: Schema.Int,
	inputCacheWrite: Schema.Int,
	outputText: Schema.Int,
	outputReasoning: Schema.Int,
	costMicros: NonNegativeMicros,
})
export type UsageTotals = typeof UsageTotals.Type

export const UsageGroupBy = Schema.Literals([
	"day",
	"model",
	"provider",
	"member",
	"bot",
	"token",
	"source",
])
export type UsageGroupBy = typeof UsageGroupBy.Type

export const UsageSummary = Schema.Struct({
	from: Schema.String,
	to: Schema.String,
	groupBy: UsageGroupBy,
	total: UsageTotals,
	/** One item for each group. `key` is null for calls without that value, such as calls without a Bot. */
	items: Schema.Array(
		Schema.Struct({ key: Schema.NullOr(Schema.String), ...UsageTotals.fields }),
	),
})
export type UsageSummary = typeof UsageSummary.Type

export const CreditGrant = Schema.Struct({
	id: Schema.String,
	/** A negative amount takes credits back. */
	amountMicros: Micros,
	note: Schema.String,
	createdBy: Schema.String,
	createdAt: Schema.String,
})
export type CreditGrant = typeof CreditGrant.Type

/**
 * The credits of an organization. When they are on, each call to a model of
 * the platform takes its cost from the balance. Calls stop when the balance is 0 or less.
 */
export const Credits = Schema.Struct({
	enabled: Schema.Boolean,
	balanceMicros: Micros,
	/** The newest grants first, at most 50. */
	grants: Schema.Array(CreditGrant),
})
export type Credits = typeof Credits.Type
export const UpdateCreditsRequest = Schema.Struct({ enabled: Schema.Boolean })
export const GrantCreditsRequest = Schema.Struct({
	amountMicros: Micros.check(
		Schema.makeFilter((value: number) =>
			value === 0 ? "Expected an amount that is not 0" : undefined,
		),
	),
	note: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
})

export const BudgetScope = Schema.Literals([
	"organization",
	"member",
	"bot",
	"token",
])
export type BudgetScope = typeof BudgetScope.Type
export const BudgetPeriod = Schema.Literals(["day", "month"])
export type BudgetPeriod = typeof BudgetPeriod.Type
/** `hard` stops model calls when the budget is spent. `soft` only marks it as exceeded. */
export const BudgetMode = Schema.Literals(["hard", "soft"])
export type BudgetMode = typeof BudgetMode.Type

export const BudgetId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/api/BudgetId"))
export type BudgetId = typeof BudgetId.Type

export const Budget = Schema.Struct({
	id: BudgetId,
	scope: BudgetScope,
	/** The user ID, Bot ID or token ID. For `organization` it is the organization ID. */
	scopeId: Schema.String,
	/** A day or a month in UTC. */
	period: BudgetPeriod,
	limitMicros: NonNegativeMicros,
	mode: BudgetMode,
	/** The start of the current period. */
	periodStart: Schema.String,
	/** The cost of the priced model calls in the current period. */
	spentMicros: NonNegativeMicros,
	exceeded: Schema.Boolean,
	version: Version,
	createdAt: Schema.String,
	updatedAt: Schema.String,
})
export type Budget = typeof Budget.Type
export const CreateBudgetRequest = Schema.Struct({
	scope: BudgetScope,
	/** Leave it out for `organization`. */
	scopeId: Schema.optionalKey(
		Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
	),
	period: BudgetPeriod,
	limitMicros: NonNegativeMicros,
	mode: BudgetMode,
})
export type CreateBudgetRequest = typeof CreateBudgetRequest.Type
export const UpdateBudgetRequest = Schema.Struct({
	expectedVersion: Version,
	limitMicros: Schema.optionalKey(NonNegativeMicros),
	mode: Schema.optionalKey(BudgetMode),
})
export type UpdateBudgetRequest = typeof UpdateBudgetRequest.Type

export class BudgetNotFound extends Schema.TaggedError<
	BudgetNotFound,
	{ readonly brand: unique symbol }
>()("BudgetNotFound", { budgetId: BudgetId }) {}
/** Someone changed the budget after you read it, or a budget for the same scope and period exists. */
export class BudgetConflict extends Schema.TaggedError<
	BudgetConflict,
	{ readonly brand: unique symbol }
>()("BudgetConflict", { message: Schema.String }) {}
export class BudgetInvalid extends Schema.TaggedError<
	BudgetInvalid,
	{ readonly brand: unique symbol }
>()("BudgetInvalid", { message: Schema.String }) {}
/** A value in the query is not valid, such as a time that is not ISO 8601. */
export class UsageQueryInvalid extends Schema.TaggedError<
	UsageQueryInvalid,
	{ readonly brand: unique symbol }
>()("UsageQueryInvalid", { message: Schema.String }) {}

/** The caller sent more requests in this minute than the platform allows. */
export class RateLimited extends Schema.TaggedError<
	RateLimited,
	{ readonly brand: unique symbol }
>()("RateLimited", {
	/** Wait this many seconds before the next request. */
	retryAfterSeconds: Schema.Int,
}) {}
