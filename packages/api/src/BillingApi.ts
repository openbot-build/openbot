import {
	UsageQueryInvalid,
	UsageEvent,
	UsageGroupBy,
	UsageSummary,
	Credits,
	BudgetId,
	Budget,
	CreateBudgetRequest,
	UpdateBudgetRequest,
	BudgetNotFound,
	BudgetConflict,
	BudgetInvalid,
} from "@openbot-build/domain/Billing"
export {
	CreditConflict,
	UsageStatus,
	UsageQueryInvalid,
	Micros,
	NonNegativeMicros,
	Rates,
	PriceTier,
	PriceTiers,
	TimeOfDay,
	Weekday,
	TimeWindow,
	PricePeriod,
	TimeZone,
	PriceSchedule,
	ModelPrice,
	SetModelPriceRequest,
	ModelPrices,
	UsageSource,
	UsageEvent,
	UsageTotals,
	UsageGroupBy,
	UsageSummary,
	CreditGrant,
	Credits,
	UpdateCreditsRequest,
	GrantCreditsRequest,
	BudgetScope,
	BudgetPeriod,
	BudgetMode,
	BudgetId,
	Budget,
	CreateBudgetRequest,
	UpdateBudgetRequest,
	BudgetNotFound,
	BudgetConflict,
	BudgetInvalid,
} from "@openbot-build/domain/Billing"
import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { BotAuth } from "./AuthApi.ts"
import {
	Authorize,
	AuthorizationErrors,
	GroupRequired,
	organization,
} from "./Authorization.ts"
import { Limit } from "./Page.ts"

export class BillingUnavailable extends Schema.TaggedError<
	BillingUnavailable,
	{ readonly brand: unique symbol }
>()("BillingUnavailable", {}) {}

const usageErrors = [
	...AuthorizationErrors,
	BillingUnavailable.pipe(HttpApiSchema.status(503)),
	UsageQueryInvalid.pipe(HttpApiSchema.status(400)),
] as const
const budgetErrors = [
	...usageErrors,
	BudgetNotFound.pipe(HttpApiSchema.status(404)),
	BudgetConflict.pipe(HttpApiSchema.status(409)),
	BudgetInvalid.pipe(HttpApiSchema.status(400)),
] as const

const range = {
	/** The start, as an ISO time. Leave it out for the start of the current month in UTC. */
	from: Schema.optionalKey(Schema.String),
	/** The end, as an ISO time. Leave it out for now. */
	to: Schema.optionalKey(Schema.String),
}

/** The model usage of the organization and its credits. */
export class UsageApi extends HttpApiGroup.make("usage")
	.add(
		HttpApiEndpoint.get("getUsage", "/v1/organization/usage", {
			query: { ...range, groupBy: Schema.optionalKey(UsageGroupBy) },
			success: UsageSummary,
			error: usageErrors,
		}).annotate(
			OpenApi.Description,
			"Adds up the tokens and the cost of the model calls in a time range. `groupBy` is `day` when you leave it out.",
		),
		HttpApiEndpoint.get("listUsageEvents", "/v1/organization/usage/events", {
			query: {
				...range,
				after: Schema.optionalKey(Schema.String),
				limit: Schema.optionalKey(Limit(200)),
			},
			success: Schema.Struct({
				items: Schema.Array(UsageEvent),
				next: Schema.NullOr(Schema.String),
			}),
			error: usageErrors,
		}).annotate(
			OpenApi.Description,
			"Lists model calls, the newest first. Send `next` as `after` to get the next page.",
		),
		HttpApiEndpoint.get("getCredits", "/v1/organization/credits", {
			success: Credits,
			error: usageErrors,
		}),
	)
	.annotate(GroupRequired, {
		read: [organization("read", "Usage")],
		write: [organization("read", "Usage")],
	})
	.middleware(Authorize)
	.middleware(BotAuth) {}

const budgetParams = { budgetId: BudgetId }

/** Spending limits of the organization, its members, its Bots and its user tokens. */
export class BudgetsApi extends HttpApiGroup.make("budgets")
	.add(
		HttpApiEndpoint.get("listBudgets", "/v1/organization/budgets", {
			success: Schema.Struct({ items: Schema.Array(Budget) }),
			error: budgetErrors,
		}),
		HttpApiEndpoint.post("createBudget", "/v1/organization/budgets", {
			payload: CreateBudgetRequest,
			success: Budget.pipe(HttpApiSchema.status(201)),
			error: budgetErrors,
		}).annotate(
			OpenApi.Description,
			"Adds a budget. Each scope can have one budget for each period.",
		),
		HttpApiEndpoint.get("getBudget", "/v1/organization/budgets/:budgetId", {
			params: budgetParams,
			success: Budget,
			error: budgetErrors,
		}),
		HttpApiEndpoint.patch(
			"updateBudget",
			"/v1/organization/budgets/:budgetId",
			{
				params: budgetParams,
				payload: UpdateBudgetRequest,
				success: Budget,
				error: budgetErrors,
			},
		),
		HttpApiEndpoint.delete(
			"deleteBudget",
			"/v1/organization/budgets/:budgetId",
			{
				params: budgetParams,
				success: HttpApiSchema.NoContent,
				error: budgetErrors,
			},
		),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	.annotate(GroupRequired, {
		read: [organization("read", "Budget")],
		write: [organization("write", "Budget")],
	})
	.middleware(Authorize)
	.middleware(BotAuth) {}
