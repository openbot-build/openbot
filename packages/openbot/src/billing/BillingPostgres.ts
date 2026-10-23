import { randomUUID } from "node:crypto"
import { BillingApi } from "@openbot-build/api"
import {
	and,
	desc,
	eq,
	gte,
	inArray,
	lt,
	lte,
	or,
	type SQL,
	sql,
} from "drizzle-orm"
import type { AnyPgColumn } from "drizzle-orm/pg-core"
import { Clock, DateTime, Effect, HashMap, Layer, Option, Ref } from "effect"
import {
	budgets,
	creditGrants,
	members,
	modelPrices,
	organizationCredits,
	organizations,
	tokens,
	usageEvents,
} from "../database/Schema.ts"
import {
	type Attribution,
	Billing,
	BillingStorageError,
	type Call,
	costOf,
	ratesOf,
	OrganizationMissing,
	periodStart,
	type Price,
	priceKey,
	SpendingBlocked,
} from "./Billing.ts"
import * as Db from "../database/Database.ts"

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis))
const newId = (prefix: string) => prefix + randomUUID().replaceAll("-", "")
/** A price change on another instance reaches this instance after at most this time. */
const priceCacheMs = 30_000

type PriceRow = typeof modelPrices.$inferSelect
type BudgetRow = typeof budgets.$inferSelect
type EventRow = typeof usageEvents.$inferSelect

/** The schedule column holds JSON that only this file writes, from a checked request. */
const scheduleOf = (row: PriceRow): BillingApi.PriceSchedule =>
	JSON.parse(row.schedule) as BillingApi.PriceSchedule

const priceView = (row: PriceRow): BillingApi.ModelPrice => ({
	model: row.modelId,
	...scheduleOf(row),
	effectiveFrom: iso(row.effectiveFrom),
})

const eventView = (row: EventRow): BillingApi.UsageEvent => ({
	id: row.id,
	occurredAt: iso(row.occurredAt),
	source: row.source as BillingApi.UsageSource,
	sessionId: row.sessionId,
	turnId: row.turnId,
	botId: row.botId,
	userId: row.userId,
	tokenId: row.tokenId,
	provider: row.providerId,
	providerOwner: row.providerOwner as BillingApi.UsageEvent["providerOwner"],
	model: row.modelId,
	inputUncached: row.inputUncached,
	inputCacheRead: row.inputCacheRead,
	inputCacheWrite: row.inputCacheWrite,
	outputText: row.outputText,
	outputReasoning: row.outputReasoning,
	priced: row.priceId !== null,
	costMicros: row.costMicros,
	charged: row.charged,
})

/** The column that a budget of each scope matches. Organization budgets match every row. */
const scopeColumn = (
	scope: BillingApi.BudgetScope,
): AnyPgColumn | undefined => {
	switch (scope) {
		case "organization":
			return undefined
		case "member":
			return usageEvents.userId
		case "bot":
			return usageEvents.botId
		case "token":
			return usageEvents.tokenId
	}
}

/** The scope ID of the attribution that a budget of this scope would match. */
const scopeIdOf = (
	scope: BillingApi.BudgetScope,
	call: Call,
	attribution: Attribution,
): string | undefined => {
	switch (scope) {
		case "organization":
			return call.organizationId
		case "member":
			return attribution.userId
		case "bot":
			return attribution.botId
		case "token":
			return attribution.tokenId
	}
}

const sumOf = <T>(value: T) =>
	sql<number>`coalesce(sum(${value}), 0)`.mapWith(Number)
const totals = {
	calls: sql<number>`count(*)`.mapWith(Number),
	inputUncached: sumOf(usageEvents.inputUncached),
	inputCacheRead: sumOf(usageEvents.inputCacheRead),
	inputCacheWrite: sumOf(usageEvents.inputCacheWrite),
	outputText: sumOf(usageEvents.outputText),
	outputReasoning: sumOf(usageEvents.outputReasoning),
	costMicros: sumOf(usageEvents.costMicros),
}

const groupColumn = (
	groupBy: BillingApi.UsageGroupBy,
): SQL<string> | AnyPgColumn => {
	switch (groupBy) {
		case "day":
			return sql<string>`to_char(to_timestamp(${usageEvents.occurredAt} / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`
		case "model":
			return usageEvents.modelId
		case "provider":
			return usageEvents.providerId
		case "member":
			return usageEvents.userId
		case "bot":
			return usageEvents.botId
		case "token":
			return usageEvents.tokenId
		case "source":
			return usageEvents.source
	}
}

/** The errors of the database driver. Billing turns them into one error. */
type DatabaseError = {
	readonly _tag:
		| "EffectDrizzleError"
		| "EffectDrizzleQueryError"
		| "EffectTransactionRollbackError"
		| "SqlError"
}
const databaseTags: ReadonlyArray<string> = [
	"EffectDrizzleError",
	"EffectDrizzleQueryError",
	"EffectTransactionRollbackError",
	"SqlError",
]
const isDatabaseError = (error: unknown): error is DatabaseError =>
	typeof error === "object" &&
	error !== null &&
	"_tag" in error &&
	databaseTags.includes(String(error._tag))
const stored = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, DatabaseError> | BillingStorageError, R> =>
	Effect.mapError(effect, (error) =>
		isDatabaseError(error)
			? new BillingStorageError({ cause: error })
			: // The guard above removed every database error.
				(error as Exclude<E, DatabaseError>),
	)

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const prices = yield* Ref.make(
		HashMap.empty<
			string,
			{ readonly price: Option.Option<Price>; readonly at: number }
		>(),
	)

	/** The price of a model at the time of a call, from a short cache. */
	const currentPrice = (providerId: string, modelId: string, now: number) =>
		Effect.gen(function* () {
			const key = priceKey(providerId, modelId)
			const cached = HashMap.get(yield* Ref.get(prices), key)
			if (Option.isSome(cached) && now - cached.value.at < priceCacheMs)
				return cached.value.price
			const [row] = yield* db
				.select()
				.from(modelPrices)
				.where(
					and(
						eq(modelPrices.providerId, providerId),
						eq(modelPrices.modelId, modelId),
						lte(modelPrices.effectiveFrom, now),
					),
				)
				.orderBy(desc(modelPrices.effectiveFrom))
				.limit(1)
			const price: Option.Option<Price> = Option.map(
				Option.fromNullishOr(row),
				(row) => ({ id: row.id, schedule: scheduleOf(row) }),
			)
			yield* Ref.update(prices, HashMap.set(key, { price, at: now }))
			return price
		})

	const spentSince = (
		organizationId: string,
		scope: BillingApi.BudgetScope,
		scopeId: string,
		since: number,
	) =>
		Effect.gen(function* () {
			const column = scopeColumn(scope)
			const [row] = yield* db
				.select({ spent: sumOf(usageEvents.costMicros) })
				.from(usageEvents)
				.where(
					and(
						eq(usageEvents.organizationId, organizationId),
						gte(usageEvents.occurredAt, since),
						column === undefined ? undefined : eq(column, scopeId),
					),
				)
			return row?.spent ?? 0
		})

	const budgetView = (row: BudgetRow, now: number) =>
		Effect.gen(function* () {
			const period = row.period as BillingApi.BudgetPeriod
			const start = periodStart(period, now)
			const scope = row.scopeKind as BillingApi.BudgetScope
			const spent = yield* spentSince(
				row.organizationId,
				scope,
				row.scopeId,
				start,
			)
			return {
				id: row.id,
				scope,
				scopeId: row.scopeId,
				period,
				limitMicros: row.limitMicros,
				mode: row.mode as BillingApi.BudgetMode,
				periodStart: iso(start),
				spentMicros: spent,
				exceeded: spent >= row.limitMicros,
				version: row.version,
				createdAt: iso(row.createdAt),
				updatedAt: iso(row.updatedAt),
			} satisfies BillingApi.Budget
		})

	const organizationExists = (organizationId: string) =>
		Effect.gen(function* () {
			const [row] = yield* db
				.select({ id: organizations.id })
				.from(organizations)
				.where(eq(organizations.id, organizationId))
			if (row === undefined)
				return yield* new OrganizationMissing({ organizationId })
		})

	const creditsView = (organizationId: string) =>
		Effect.gen(function* () {
			yield* organizationExists(organizationId)
			const [row] = yield* db
				.select()
				.from(organizationCredits)
				.where(eq(organizationCredits.organizationId, organizationId))
			const grants = yield* db
				.select()
				.from(creditGrants)
				.where(eq(creditGrants.organizationId, organizationId))
				.orderBy(desc(creditGrants.createdAt), desc(creditGrants.id))
				.limit(50)
			return {
				enabled: row?.enabled ?? false,
				balanceMicros: row?.balanceMicros ?? 0,
				grants: grants.map(grantView),
			} satisfies BillingApi.Credits
		})

	const grantView = (
		row: typeof creditGrants.$inferSelect,
	): BillingApi.CreditGrant => ({
		id: row.id,
		amountMicros: row.amountMicros,
		note: row.note,
		createdBy: row.createdBy,
		createdAt: iso(row.createdAt),
	})

	const budgetWhere = (organizationId: string, id: string) =>
		and(eq(budgets.organizationId, organizationId), eq(budgets.id, id))
	const budgetNotFound = (id: string) =>
		BillingApi.BudgetNotFound.make({ budgetId: id })

	/** The scope ID of a new budget. It checks that the member or token is in the organization. */
	const resolveScope = (
		organizationId: string,
		input: BillingApi.CreateBudgetRequest,
	) =>
		Effect.gen(function* () {
			const invalid = (message: string) =>
				BillingApi.BudgetInvalid.make({ message })
			if (input.scope === "organization") {
				if (input.scopeId !== undefined && input.scopeId !== organizationId)
					return yield* invalid(
						"An organization budget can only name this organization.",
					)
				return organizationId
			}
			if (input.scopeId === undefined)
				return yield* invalid(`A ${input.scope} budget needs a scopeId.`)
			if (input.scope === "member") {
				const [row] = yield* db
					.select({ userId: members.userId })
					.from(members)
					.where(
						and(
							eq(members.organizationId, organizationId),
							eq(members.userId, input.scopeId),
						),
					)
				if (row === undefined)
					return yield* invalid("No member of the organization has this ID.")
			}
			if (input.scope === "token") {
				const [row] = yield* db
					.select({ id: tokens.id })
					.from(tokens)
					.where(
						and(
							eq(tokens.organizationId, organizationId),
							eq(tokens.id, input.scopeId),
						),
					)
				if (row === undefined)
					return yield* invalid("No token of the organization has this ID.")
			}
			return input.scopeId
		})

	return Billing.of({
		botSpend: (botId, since) =>
			stored(
				Effect.gen(function* () {
					const [row] = yield* db
						.select({ spent: sumOf(usageEvents.costMicros) })
						.from(usageEvents)
						.where(
							and(
								eq(usageEvents.botId, botId),
								gte(usageEvents.occurredAt, since),
							),
						)
					return row?.spent ?? 0
				}),
			),
		check: (call, attribution) =>
			stored(
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const hard = (yield* db
						.select()
						.from(budgets)
						.where(
							and(
								eq(budgets.organizationId, call.organizationId),
								eq(budgets.mode, "hard"),
							),
						)).filter(
						(budget) =>
							scopeIdOf(
								budget.scopeKind as BillingApi.BudgetScope,
								call,
								attribution,
							) === budget.scopeId,
					)
					if (hard.length > 0) {
						const starts = hard.map((budget) =>
							periodStart(budget.period as BillingApi.BudgetPeriod, now),
						)
						// One pass over the rows of this month gives the spend of every budget.
						const columns = Object.fromEntries(
							hard.map((budget, index) => {
								const column = scopeColumn(
									budget.scopeKind as BillingApi.BudgetScope,
								)
								const filter =
									column === undefined
										? sql`${usageEvents.occurredAt} >= ${starts[index]}`
										: sql`${usageEvents.occurredAt} >= ${starts[index]} AND ${column} = ${budget.scopeId}`
								return [
									"b" + index,
									sql<number>`coalesce(sum(${usageEvents.costMicros}) FILTER (WHERE ${filter}), 0)`.mapWith(
										Number,
									),
								]
							}),
						)
						const [spent] = yield* db
							.select(columns)
							.from(usageEvents)
							.where(
								and(
									eq(usageEvents.organizationId, call.organizationId),
									gte(usageEvents.occurredAt, Math.min(...starts)),
								),
							)
						for (const [index, budget] of hard.entries()) {
							if (Number(spent?.["b" + index] ?? 0) >= budget.limitMicros)
								return yield* new SpendingBlocked({
									reason: "budget",
									budgetId: budget.id,
									message: `The ${budget.period} budget of this ${budget.scopeKind} is spent.`,
								})
						}
					}
					if (call.providerOwner === "platform") {
						const [credits] = yield* db
							.select()
							.from(organizationCredits)
							.where(
								eq(organizationCredits.organizationId, call.organizationId),
							)
						if (credits?.enabled === true && credits.balanceMicros <= 0)
							return yield* new SpendingBlocked({
								reason: "credits",
								message: "The organization has no credits left.",
							})
					}
				}),
			),
		record: (call, attribution, used, startedAt) =>
			stored(
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					// The price at the start of the call applies, also when the call ends later.
					const price = yield* currentPrice(
						call.providerId,
						call.modelId,
						startedAt,
					)
					const cost = Option.match(price, {
						onNone: () => 0,
						onSome: (price) =>
							costOf(used, ratesOf(price.schedule, used, startedAt)),
					})
					yield* db.transaction((tx) =>
						Effect.gen(function* () {
							const [credits] =
								call.providerOwner === "platform"
									? yield* tx
											.select()
											.from(organizationCredits)
											.where(
												eq(
													organizationCredits.organizationId,
													call.organizationId,
												),
											)
											.for("update")
									: []
							const charged = credits?.enabled === true
							yield* tx.insert(usageEvents).values({
								id: newId("usage_"),
								organizationId: call.organizationId,
								occurredAt: now,
								source: attribution.source,
								sessionId: attribution.sessionId ?? null,
								turnId: attribution.turnId ?? null,
								botId: attribution.botId ?? null,
								userId: attribution.userId ?? null,
								tokenId: attribution.tokenId ?? null,
								providerId: call.providerId,
								providerOwner: call.providerOwner,
								modelId: call.modelId,
								...used,
								priceId: Option.match(price, {
									onNone: () => null,
									onSome: (price) => price.id,
								}),
								costMicros: cost,
								charged,
							})
							if (charged && cost > 0)
								yield* tx
									.update(organizationCredits)
									.set({
										balanceMicros: sql`${organizationCredits.balanceMicros} - ${cost}`,
										updatedAt: now,
									})
									.where(
										eq(organizationCredits.organizationId, call.organizationId),
									)
						}),
					)
				}),
			),
		prices: (providerId) =>
			stored(
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const rows = yield* db
						.selectDistinctOn([modelPrices.modelId])
						.from(modelPrices)
						.where(
							and(
								eq(modelPrices.providerId, providerId),
								lte(modelPrices.effectiveFrom, now),
							),
						)
						.orderBy(modelPrices.modelId, desc(modelPrices.effectiveFrom))
					return rows.map(priceView)
				}),
			),
		setPrice: (providerId, input, createdBy) =>
			stored(
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const [row] = yield* db
						.insert(modelPrices)
						.values({
							id: newId("price_"),
							providerId,
							modelId: input.model,
							effectiveFrom: now,
							schedule: JSON.stringify({
								timeZone: input.timeZone ?? "UTC",
								tiers: input.tiers,
								periods: input.periods ?? [],
							} satisfies BillingApi.PriceSchedule),
							createdBy,
							createdAt: now,
						})
						.returning()
					yield* Ref.update(
						prices,
						HashMap.remove(priceKey(providerId, input.model)),
					)
					return priceView(row!)
				}),
			),
		currentPrices: (providerIds) =>
			stored(
				Effect.gen(function* () {
					if (providerIds.length === 0) return new Map()
					const now = yield* Clock.currentTimeMillis
					const rows = yield* db
						.selectDistinctOn([modelPrices.providerId, modelPrices.modelId])
						.from(modelPrices)
						.where(
							and(
								inArray(modelPrices.providerId, [...providerIds]),
								lte(modelPrices.effectiveFrom, now),
							),
						)
						.orderBy(
							modelPrices.providerId,
							modelPrices.modelId,
							desc(modelPrices.effectiveFrom),
						)
					return new Map(
						rows.map((row) => [
							priceKey(row.providerId, row.modelId),
							priceView(row),
						]),
					)
				}),
			),
		summary: (organizationId, range, groupBy) =>
			stored(
				Effect.gen(function* () {
					const where = and(
						eq(usageEvents.organizationId, organizationId),
						gte(usageEvents.occurredAt, range.from),
						lt(usageEvents.occurredAt, range.to),
					)
					const key = groupColumn(groupBy)
					const items = yield* db
						.select({ key, ...totals })
						.from(usageEvents)
						.where(where)
						.groupBy(key)
						.orderBy(key)
					const [total] = yield* db
						.select(totals)
						.from(usageEvents)
						.where(where)
					return {
						from: iso(range.from),
						to: iso(range.to),
						groupBy,
						total: total ?? {
							calls: 0,
							inputUncached: 0,
							inputCacheRead: 0,
							inputCacheWrite: 0,
							outputText: 0,
							outputReasoning: 0,
							costMicros: 0,
						},
						items,
					}
				}),
			),
		events: (organizationId, range, page) =>
			stored(
				Effect.gen(function* () {
					const cursor = page.after?.split(".")
					const after =
						cursor?.length === 2 && Number.isFinite(Number(cursor[0]))
							? { at: Number(cursor[0]), id: cursor[1]! }
							: undefined
					const rows = yield* db
						.select()
						.from(usageEvents)
						.where(
							and(
								eq(usageEvents.organizationId, organizationId),
								gte(usageEvents.occurredAt, range.from),
								lt(usageEvents.occurredAt, range.to),
								after === undefined
									? undefined
									: or(
											lt(usageEvents.occurredAt, after.at),
											and(
												eq(usageEvents.occurredAt, after.at),
												lt(usageEvents.id, after.id),
											),
										),
							),
						)
						.orderBy(desc(usageEvents.occurredAt), desc(usageEvents.id))
						.limit(page.limit + 1)
					const items = rows.slice(0, page.limit)
					const last = items.at(-1)
					return {
						items: items.map(eventView),
						next:
							rows.length > page.limit && last !== undefined
								? `${last.occurredAt}.${last.id}`
								: null,
					}
				}),
			),
		credits: (organizationId) => stored(creditsView(organizationId)),
		setCreditsEnabled: (organizationId, enabled) =>
			stored(
				Effect.gen(function* () {
					yield* organizationExists(organizationId)
					const now = yield* Clock.currentTimeMillis
					yield* db
						.insert(organizationCredits)
						.values({
							organizationId,
							enabled,
							balanceMicros: 0,
							updatedAt: now,
						})
						.onConflictDoUpdate({
							target: organizationCredits.organizationId,
							set: { enabled, updatedAt: now },
						})
					return yield* creditsView(organizationId)
				}),
			),
		grantCredits: (organizationId, input, createdBy) =>
			stored(
				Effect.gen(function* () {
					yield* organizationExists(organizationId)
					const now = yield* Clock.currentTimeMillis
					return yield* db.transaction((tx) =>
						Effect.gen(function* () {
							const [grant] = yield* tx
								.insert(creditGrants)
								.values({
									id: newId("grant_"),
									organizationId,
									amountMicros: input.amountMicros,
									note: input.note,
									createdBy,
									createdAt: now,
								})
								.returning()
							yield* tx
								.insert(organizationCredits)
								.values({
									organizationId,
									enabled: false,
									balanceMicros: input.amountMicros,
									updatedAt: now,
								})
								.onConflictDoUpdate({
									target: organizationCredits.organizationId,
									set: {
										balanceMicros: sql`${organizationCredits.balanceMicros} + ${input.amountMicros}`,
										updatedAt: now,
									},
								})
							return grantView(grant!)
						}),
					)
				}),
			),
		budgets: (organizationId) =>
			stored(
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const rows = yield* db
						.select()
						.from(budgets)
						.where(eq(budgets.organizationId, organizationId))
						.orderBy(budgets.createdAt, budgets.id)
					return yield* Effect.forEach(rows, (row) => budgetView(row, now))
				}),
			),
		budget: (organizationId, id) =>
			stored(
				Effect.gen(function* () {
					const [row] = yield* db
						.select()
						.from(budgets)
						.where(budgetWhere(organizationId, id))
					if (row === undefined) return yield* budgetNotFound(id)
					return yield* budgetView(row, yield* Clock.currentTimeMillis)
				}),
			),
		createBudget: (organizationId, input) =>
			stored(
				Effect.gen(function* () {
					const scopeId = yield* resolveScope(organizationId, input)
					const now = yield* Clock.currentTimeMillis
					const [row] = yield* db
						.insert(budgets)
						.values({
							id: newId("budget_"),
							organizationId,
							scopeKind: input.scope,
							scopeId,
							period: input.period,
							limitMicros: input.limitMicros,
							mode: input.mode,
							version: 1,
							createdAt: now,
							updatedAt: now,
						})
						.onConflictDoNothing()
						.returning()
					if (row === undefined)
						return yield* BillingApi.BudgetConflict.make({
							message: "This scope already has a budget for this period.",
						})
					return yield* budgetView(row, now)
				}),
			),
		updateBudget: (organizationId, id, input) =>
			stored(
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const row = yield* db.transaction((tx) =>
						Effect.gen(function* () {
							const [row] = yield* tx
								.select()
								.from(budgets)
								.where(budgetWhere(organizationId, id))
								.for("update")
							if (row === undefined) return yield* budgetNotFound(id)
							if (row.version !== input.expectedVersion)
								return yield* BillingApi.BudgetConflict.make({
									message: `The budget changed. Its version is now ${row.version}.`,
								})
							const [updated] = yield* tx
								.update(budgets)
								.set({
									...(input.limitMicros === undefined
										? {}
										: { limitMicros: input.limitMicros }),
									...(input.mode === undefined ? {} : { mode: input.mode }),
									version: row.version + 1,
									updatedAt: now,
								})
								.where(budgetWhere(organizationId, id))
								.returning()
							return updated!
						}),
					)
					return yield* budgetView(row, now)
				}),
			),
		deleteBudget: (organizationId, id) =>
			stored(
				Effect.gen(function* () {
					const deleted = yield* db
						.delete(budgets)
						.where(budgetWhere(organizationId, id))
						.returning({ id: budgets.id })
					if (deleted.length === 0) return yield* budgetNotFound(id)
				}),
			),
	})
})

export const layer = Layer.effect(Billing, make)
