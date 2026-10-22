import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { AgentAuth } from "./AuthApi.ts"
import {
	Authorize,
	GroupRequired,
	PermissionErrors,
	requires,
} from "./Permissions.ts"
import { Version } from "./Settings.ts"

/**
 * An amount of money in micro-USD. One US dollar is 1,000,000 micro-USD.
 * Whole numbers keep sums exact.
 */
export const Micros = Schema.Int
export const NonNegativeMicros = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(0),
)

/**
 * The price of a model at one provider. Each value is the cost of one million
 * tokens, in micro-USD. For example, 2500000 is 2.50 US dollars.
 */
export const ModelPrice = Schema.Struct({
	model: Schema.String,
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
	/** The time from which this price applies. */
	effectiveFrom: Schema.String,
})
export type ModelPrice = typeof ModelPrice.Type
export const SetModelPriceRequest = Schema.Struct({
	model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
	inputUncached: NonNegativeMicros,
	inputCacheRead: NonNegativeMicros,
	inputCacheWrite: NonNegativeMicros,
	output: NonNegativeMicros,
	outputReasoning: Schema.optionalKey(Schema.NullOr(NonNegativeMicros)),
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
	/** The memory of a Session. */
	"session_memory",
	/** The model that judges Rules. */
	"judge",
	/** The model that learns Agent memory. */
	"agent_memory",
	"other",
])
export type UsageSource = typeof UsageSource.Type

/** The tokens and cost of one model call. */
export const UsageEvent = Schema.Struct({
	id: Schema.String,
	occurredAt: Schema.String,
	source: UsageSource,
	sessionId: Schema.NullOr(Schema.String),
	turnId: Schema.NullOr(Schema.String),
	agentId: Schema.NullOr(Schema.String),
	userId: Schema.NullOr(Schema.String),
	tokenId: Schema.NullOr(Schema.String),
	provider: Schema.String,
	/** `platform` when the platform paid for the call, `organization` when the organization used its own API key. */
	providerOwner: Schema.Literals(["platform", "organization"]),
	model: Schema.String,
	inputUncached: Schema.Int,
	inputCacheRead: Schema.Int,
	inputCacheWrite: Schema.Int,
	outputText: Schema.Int,
	outputReasoning: Schema.Int,
	/** False when the model had no price. Then the cost is 0. */
	priced: Schema.Boolean,
	costMicros: NonNegativeMicros,
	/** True when the cost was taken from the credits of the organization. */
	charged: Schema.Boolean,
})
export type UsageEvent = typeof UsageEvent.Type

export const UsageTotals = Schema.Struct({
	calls: Schema.Int,
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
	"agent",
	"token",
	"source",
])
export type UsageGroupBy = typeof UsageGroupBy.Type

export const UsageSummary = Schema.Struct({
	from: Schema.String,
	to: Schema.String,
	groupBy: UsageGroupBy,
	total: UsageTotals,
	/** One item for each group. `key` is null for calls without that value, such as calls without an Agent. */
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
	"agent",
	"token",
])
export type BudgetScope = typeof BudgetScope.Type
export const BudgetPeriod = Schema.Literals(["day", "month"])
export type BudgetPeriod = typeof BudgetPeriod.Type
/** `hard` stops model calls when the budget is spent. `soft` only marks it as exceeded. */
export const BudgetMode = Schema.Literals(["hard", "soft"])
export type BudgetMode = typeof BudgetMode.Type

export const Budget = Schema.Struct({
	id: Schema.String,
	scope: BudgetScope,
	/** The user ID, Agent ID or token ID. For `organization` it is the organization ID. */
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

export class BudgetNotFound extends Schema.TaggedError<BudgetNotFound>()(
	"BudgetNotFound",
	{ budgetId: Schema.String },
) {}
/** Someone changed the budget after you read it, or a budget for the same scope and period exists. */
export class BudgetConflict extends Schema.TaggedError<BudgetConflict>()(
	"BudgetConflict",
	{ message: Schema.String },
) {}
export class BudgetInvalid extends Schema.TaggedError<BudgetInvalid>()(
	"BudgetInvalid",
	{ message: Schema.String },
) {}
/** A value in the query is not valid, such as a time that is not ISO 8601. */
export class UsageQueryInvalid extends Schema.TaggedError<UsageQueryInvalid>()(
	"UsageQueryInvalid",
	{ message: Schema.String },
) {}
export class BillingUnavailable extends Schema.TaggedError<BillingUnavailable>()(
	"BillingUnavailable",
	{},
) {}

const usageErrors = [
	...PermissionErrors,
	BillingUnavailable.pipe(HttpApiSchema.status(503)),
	UsageQueryInvalid.pipe(HttpApiSchema.status(400)),
] as const
const budgetErrors = [
	...usageErrors,
	BudgetNotFound.pipe(HttpApiSchema.status(404)),
	BudgetConflict.pipe(HttpApiSchema.status(409)),
	BudgetInvalid.pipe(HttpApiSchema.status(400)),
] as const

const Limit = Schema.FiniteFromString.check(
	Schema.isBetween({ minimum: 1, maximum: 200 }),
)
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
				limit: Schema.optionalKey(Limit),
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
		read: [requires("usage.read").on("organization")],
		write: [requires("usage.read").on("organization")],
	})
	.middleware(Authorize)
	.middleware(AgentAuth) {}

const budgetParams = { budgetId: Schema.String }

/** Spending limits of the organization, its members, its Agents and its user tokens. */
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
		read: [requires("budgets.read").on("organization")],
		write: [requires("budgets.write").on("organization")],
	})
	.middleware(Authorize)
	.middleware(AgentAuth) {}
