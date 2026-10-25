import {
	BillingApi,
	type Caller,
	Identity,
	OpenBotApi,
} from "@openbot-build/api"
import { Clock, Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { AuditLog } from "../audit/AuditLog.ts"
import { organizationKey } from "../audit/Resources.ts"
import { Billing, periodStart } from "./Billing.ts"

/** Turns the `from` and `to` of a query into milliseconds. */
const rangeOf = (query: { readonly from?: string; readonly to?: string }) =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis
		const parse = (value: string | undefined, fallback: number) => {
			if (value === undefined) return Effect.succeed(fallback)
			const millis = Date.parse(value)
			return Number.isFinite(millis)
				? Effect.succeed(millis)
				: Effect.fail(
						BillingApi.UsageQueryInvalid.make({
							message: `"${value}" is not an ISO 8601 time.`,
						}),
					)
		}
		const from = yield* parse(query.from, periodStart("month", now))
		const to = yield* parse(query.to, now + 1)
		if (from >= to)
			return yield* BillingApi.UsageQueryInvalid.make({
				message: "`from` must be before `to`.",
			})
		return { from, to }
	})

const usage = HttpApiBuilder.group(OpenBotApi, "usage", (handlers) =>
	Effect.gen(function* () {
		const billing = yield* Billing
		return handlers
			.handle("getUsage", ({ query }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const range = yield* rangeOf(query)
					return yield* billing
						.summary(caller.organizationId, range, query.groupBy ?? "day")
						.pipe(Effect.mapError(() => BillingApi.BillingUnavailable.make({})))
				}),
			)
			.handle("listUsageEvents", ({ query }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const range = yield* rangeOf(query)
					return yield* billing
						.events(caller.organizationId, range, {
							limit: query.limit ?? 50,
							...(query.after === undefined ? {} : { after: query.after }),
						})
						.pipe(Effect.mapError(() => BillingApi.BillingUnavailable.make({})))
				}),
			)
			.handle("getCredits", () =>
				Effect.gen(function* () {
					const caller = yield* Identity
					return yield* billing
						.credits(caller.organizationId)
						.pipe(Effect.mapError(() => BillingApi.BillingUnavailable.make({})))
				}),
			)
	}),
)

const budgets = HttpApiBuilder.group(OpenBotApi, "budgets", (handlers) =>
	Effect.gen(function* () {
		const billing = yield* Billing
		const audit = yield* AuditLog
		const record = (
			caller: Caller,
			action: "budget.created" | "budget.updated" | "budget.deleted",
			budget: Pick<
				BillingApi.Budget,
				"id" | "scope" | "scopeId" | "period" | "limitMicros" | "mode"
			>,
		) =>
			audit
				.record({
					organizationId: caller.organizationId,
					action,
					actor: caller,
					resource: organizationKey(caller.organizationId),
					details: {
						budgetId: budget.id,
						scope: budget.scope,
						scopeId: budget.scopeId,
						period: budget.period,
						limitMicros: budget.limitMicros,
						mode: budget.mode,
					},
				})
				.pipe(Effect.mapError(() => BillingApi.BillingUnavailable.make({})))
		return handlers
			.handle("listBudgets", () =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const items = yield* billing
						.budgets(caller.organizationId)
						.pipe(
							Effect.catchTag("BillingStorageError", () =>
								Effect.fail(BillingApi.BillingUnavailable.make({})),
							),
						)
					return { items }
				}),
			)
			.handle("createBudget", ({ payload }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const created = yield* billing
						.createBudget(caller.organizationId, payload)
						.pipe(
							Effect.catchTag("BillingStorageError", () =>
								Effect.fail(BillingApi.BillingUnavailable.make({})),
							),
						)
					yield* record(caller, "budget.created", created)
					return created
				}),
			)
			.handle("getBudget", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					return yield* billing
						.budget(caller.organizationId, params.budgetId)
						.pipe(
							Effect.catchTag("BillingStorageError", () =>
								Effect.fail(BillingApi.BillingUnavailable.make({})),
							),
						)
				}),
			)
			.handle("updateBudget", ({ params, payload }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const updated = yield* billing
						.updateBudget(caller.organizationId, params.budgetId, payload)
						.pipe(
							Effect.catchTag("BillingStorageError", () =>
								Effect.fail(BillingApi.BillingUnavailable.make({})),
							),
						)
					yield* record(caller, "budget.updated", updated)
					return updated
				}),
			)
			.handle("deleteBudget", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const budget = yield* billing
						.budget(caller.organizationId, params.budgetId)
						.pipe(
							Effect.catchTag("BillingStorageError", () =>
								Effect.fail(BillingApi.BillingUnavailable.make({})),
							),
						)
					yield* billing
						.deleteBudget(caller.organizationId, params.budgetId)
						.pipe(
							Effect.catchTag("BillingStorageError", () =>
								Effect.fail(BillingApi.BillingUnavailable.make({})),
							),
						)
					yield* record(caller, "budget.deleted", budget)
				}),
			)
	}),
)

export const layer = Layer.mergeAll(usage, budgets)
