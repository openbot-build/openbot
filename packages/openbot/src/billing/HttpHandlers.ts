import {
	BillingApi,
	type Caller,
	Identity,
	OpenBotApi,
} from "@openbot-build/api"
import { Clock, DateTime, Effect, Layer, Option } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import * as Failures from "../app/Failures.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { organizationKey } from "../audit/Resources.ts"
import { Billing, periodStart } from "./Billing.ts"

/** Fails with `BillingUnavailable` in place of an inside failure, and logs the failure. */
const unavailable = (message: string) =>
	Failures.replace(message, () => BillingApi.BillingUnavailable.make({}))
/**
 * Fails with `BillingUnavailable` in place of a storage failure, and logs the
 * failure. Other failures keep their meaning.
 */
const storageUnavailable = (message: string) =>
	Failures.replaceTag("BillingStorageError", message, () =>
		BillingApi.BillingUnavailable.make({}),
	)

/** Turns the `from` and `to` of a query into milliseconds. */
const rangeOf = (query: { readonly from?: string; readonly to?: string }) =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis
		// A time without a zone is in UTC.
		const parse = (value: string | undefined, fallback: number) =>
			value === undefined
				? Effect.succeed(fallback)
				: Option.match(DateTime.make(value), {
						onNone: () =>
							Effect.fail(
								BillingApi.UsageQueryInvalid.make({
									message: `"${value}" is not an ISO 8601 time.`,
								}),
							),
						onSome: (time) => Effect.succeed(DateTime.toEpochMillis(time)),
					})
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
						.pipe(unavailable("The usage summary could not be read."))
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
						.pipe(
							Failures.replaceTag(
								"BillingStorageError",
								"The usage events could not be read.",
								() => BillingApi.BillingUnavailable.make({}),
							),
						)
				}),
			)
			.handle("getCredits", () =>
				Effect.gen(function* () {
					const caller = yield* Identity
					return yield* billing.credits(caller.organizationId).pipe(
						// Members and tokens need their organization, and no one deletes
						// an organization. So a missing organization here is a bug.
						Effect.catchTag("OrganizationMissing", (error) =>
							Effect.die(error),
						),
						unavailable("The credits could not be read."),
					)
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
				.pipe(unavailable("The audit log could not record a budget change."))
		return handlers
			.handle("listBudgets", () =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const items = yield* billing
						.budgets(caller.organizationId)
						.pipe(storageUnavailable("The budgets could not be read."))
					return { items }
				}),
			)
			.handle("createBudget", ({ payload }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const created = yield* billing
						.createBudget(caller.organizationId, payload)
						.pipe(storageUnavailable("The budget could not be created."))
					yield* record(caller, "budget.created", created)
					return created
				}),
			)
			.handle("getBudget", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					return yield* billing
						.budget(caller.organizationId, params.budgetId)
						.pipe(storageUnavailable("The budget could not be read."))
				}),
			)
			.handle("updateBudget", ({ params, payload }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const updated = yield* billing
						.updateBudget(caller.organizationId, params.budgetId, payload)
						.pipe(storageUnavailable("The budget could not be changed."))
					yield* record(caller, "budget.updated", updated)
					return updated
				}),
			)
			.handle("deleteBudget", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const budget = yield* billing
						.budget(caller.organizationId, params.budgetId)
						.pipe(storageUnavailable("The budget could not be read."))
					yield* billing
						.deleteBudget(caller.organizationId, params.budgetId)
						.pipe(storageUnavailable("The budget could not be deleted."))
					yield* record(caller, "budget.deleted", budget)
				}),
			)
	}),
)

export const layer = Layer.mergeAll(usage, budgets)
