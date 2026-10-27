import { Model, Provider } from "@openbot-build/core"
import {
	Billing as BillingApi,
	TokenId,
	Execution,
} from "@openbot-build/domain"

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
import {
	Array as Arr,
	Clock,
	Crypto,
	DateTime,
	Effect,
	HashMap,
	Layer,
	Option,
	Predicate,
	Schema,
	SchemaTransformation,
	String as Str,
} from "effect"
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
import { executions, executionCalls } from "../database/ExecutionSchema.ts"
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
	SpendingBlocked,
} from "./Billing.ts"
import { PgClient } from "@effect/sql-pg"
import * as Db from "../database/Database.ts"

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis))
/**
 * The cursor of a page of usage events is `<time>.<id>` of the last event on the page.
 */
const UsageCursor = Schema.TemplateLiteralParser([
	Schema.Finite,
	".",
	Schema.NonEmptyString,
]).pipe(
	Schema.decodeTo(
		Schema.Struct({ at: Schema.Finite, id: Schema.String }),
		SchemaTransformation.transform({
			decode: ([at, , id]) => ({ at, id }),
			encode: ({ at, id }) => [at, ".", id] as const,
		}),
	),
)
const decodeCursor = Schema.decodeUnknownOption(UsageCursor)
const encodeCursor = (cursor: typeof UsageCursor.Type) =>
	Schema.encodeEffect(UsageCursor)(cursor).pipe(
		Effect.mapError((cause) => BillingStorageError.make({ cause })),
	)

/** A price change on another instance reaches this instance after at most this time. */

type PriceRow = typeof modelPrices.$inferSelect
type BudgetRow = typeof budgets.$inferSelect
type EventRow = typeof usageEvents.$inferSelect

/** Reads a stored value back. A value that does not decode is a storage error. */
const decodeStored =
	<S extends Schema.Decoder<unknown>>(schema: S) =>
	(input: unknown): Effect.Effect<S["Type"], BillingStorageError> =>
		Schema.decodeUnknownEffect(schema)(input).pipe(
			Effect.mapError((cause) => BillingStorageError.make({ cause })),
		)

/** The text columns hold the values of the API, so these read them back. */
const decodeSource = decodeStored(BillingApi.UsageSource)
const decodeProviderOwner = decodeStored(
	BillingApi.UsageEvent.fields.providerOwner,
)
const decodePeriod = decodeStored(BillingApi.BudgetPeriod)
const decodeScope = decodeStored(BillingApi.BudgetScope)
const decodeMode = decodeStored(BillingApi.BudgetMode)

/** The schedule column holds JSON that only this file writes, from a checked request. */
const ScheduleJson = Schema.fromJsonString(BillingApi.PriceSchedule)
const decodeSchedule = decodeStored(ScheduleJson)
const encodeSchedule = (schedule: BillingApi.PriceSchedule) =>
	Schema.encodeEffect(ScheduleJson)(schedule).pipe(Effect.orDie)

const priceView = (row: PriceRow) =>
	Effect.map(
		decodeSchedule(row.schedule),
		(schedule): BillingApi.ModelPrice => ({
			model: Model.Id.make(row.modelId),
			...schedule,
			effectiveFrom: iso(row.effectiveFrom),
		}),
	)

const eventView = (row: EventRow) =>
	Effect.map(
		Effect.all({
			source: decodeSource(row.source),
			status: decodeStored(BillingApi.UsageStatus)(row.status),
			providerOwner: decodeProviderOwner(row.providerOwner),
		}),
		({ source, providerOwner, status }): BillingApi.UsageEvent => ({
			id: Execution.CallId.make(row.id),
			executionId:
				row.executionId === null ? null : Execution.Id.make(row.executionId),
			status,
			startedAt: iso(row.startedAt ?? row.occurredAt),
			reservedMicros: row.reservedMicros,
			estimatedMicros: row.estimatedMicros,
			estimatedTokens: row.estimatedTokens,
			occurredAt: iso(row.occurredAt),
			source,
			chatId: row.chatId,
			turnId: row.turnId,
			botId: row.botId,
			userId: row.userId,
			tokenId: row.tokenId === null ? null : TokenId.make(row.tokenId),
			provider: Provider.Id.make(row.providerId),
			providerOwner,
			model: Model.Id.make(row.modelId),
			inputUncached: status === "confirmed" ? row.inputUncached : null,
			inputCacheRead: status === "confirmed" ? row.inputCacheRead : null,
			inputCacheWrite: status === "confirmed" ? row.inputCacheWrite : null,
			outputText: status === "confirmed" ? row.outputText : null,
			outputReasoning: status === "confirmed" ? row.outputReasoning : null,
			priced: row.priceId !== null,
			costMicros: status === "confirmed" ? row.costMicros : null,
			charged: row.charged,
		}),
	)

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
	calls:
		sql<number>`count(*) FILTER (WHERE ${usageEvents.status} = 'confirmed')`.mapWith(
			Number,
		),
	pendingCalls:
		sql<number>`count(*) FILTER (WHERE ${usageEvents.status} = 'pending')`.mapWith(
			Number,
		),
	unknownCalls:
		sql<number>`count(*) FILTER (WHERE ${usageEvents.status} = 'unknown')`.mapWith(
			Number,
		),
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

/** The tags of the errors of the database driver. Billing turns them into one error. */
const databaseTags = [
	"EffectDrizzleError",
	"EffectDrizzleQueryError",
	"EffectTransactionRollbackError",
	"SqlError",
] as const
type DatabaseError = { readonly _tag: (typeof databaseTags)[number] }
const isDatabaseError = (error: unknown): error is DatabaseError =>
	Predicate.hasProperty(error, "_tag") && Arr.contains(databaseTags, error._tag)
const stored = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.catchIf(
		effect,
		(error): error is Extract<E, DatabaseError> => isDatabaseError(error),
		(cause) =>
			Effect.fail(BillingStorageError.make({ cause, retryable: true })),
	)

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const client = yield* PgClient.PgClient
	const crypto = yield* Crypto.Crypto
	const newId = (prefix: string) =>
		Effect.map(
			Effect.orDie(crypto.randomUUIDv4()),
			(uuid) => prefix + Str.replaceAll("-", "")(uuid),
		)
	/** The price of a model that applies at a time. */
	const priceAtFromStorage = (
		providerId: string,
		modelId: string,
		at: number,
	) =>
		Effect.gen(function* () {
			const [row] = yield* db
				.select()
				.from(modelPrices)
				.where(
					and(
						eq(modelPrices.providerId, providerId),
						eq(modelPrices.modelId, modelId),
						lte(modelPrices.effectiveFrom, at),
					),
				)
				.orderBy(desc(modelPrices.effectiveFrom), desc(modelPrices.position))
				.limit(1)
			return row === undefined
				? Option.none<Price>()
				: Option.some<Price>({
						id: row.id,
						effectiveFrom: row.effectiveFrom,
						schedule: yield* decodeSchedule(row.schedule),
					})
		})

	/** The spend of the usage events that match the filter. */
	const spend = (where: SQL | undefined) =>
		db
			.select({ spent: sumOf(usageEvents.costMicros) })
			.from(usageEvents)
			.where(where)
			.pipe(Effect.map(([row]) => row?.spent ?? 0))

	const spentSince = (
		organizationId: string,
		scope: BillingApi.BudgetScope,
		scopeId: string,
		since: number,
	) => {
		const column = scopeColumn(scope)
		return spend(
			and(
				eq(usageEvents.organizationId, organizationId),
				gte(usageEvents.occurredAt, since),
				column === undefined ? undefined : eq(column, scopeId),
			),
		)
	}

	const budgetView = (row: BudgetRow, now: number) =>
		Effect.gen(function* () {
			const period = yield* decodePeriod(row.period)
			const start = periodStart(period, now)
			const scope = yield* decodeScope(row.scopeKind)
			const spent = yield* spentSince(
				row.organizationId,
				scope,
				row.scopeId,
				start,
			)
			return {
				id: BillingApi.BudgetId.make(row.id),
				scope,
				scopeId: row.scopeId,
				period,
				limitMicros: row.limitMicros,
				mode: yield* decodeMode(row.mode),
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
				return yield* OrganizationMissing.make({ organizationId })
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
				grants: Arr.map(grants, grantView),
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

	/** The scope ID of a new budget. It checks that the member or token is in the organization. */
	const resolveScope = (
		organizationId: string,
		input: BillingApi.CreateBudgetRequest,
	) =>
		Effect.gen(function* () {
			if (input.scope === "organization") {
				if (input.scopeId !== undefined && input.scopeId !== organizationId)
					return yield* BillingApi.BudgetInvalid.make({
						message: "An organization budget can only name this organization.",
					})
				return organizationId
			}
			if (input.scopeId === undefined)
				return yield* BillingApi.BudgetInvalid.make({
					message: `A ${input.scope} budget needs a scopeId.`,
				})
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
					return yield* BillingApi.BudgetInvalid.make({
						message: "No member of the organization has this ID.",
					})
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
					return yield* BillingApi.BudgetInvalid.make({
						message: "No token of the organization has this ID.",
					})
			}
			return input.scopeId
		})

	return Billing.of({
		botSpend: (botId, since) =>
			stored(
				spend(
					and(eq(usageEvents.botId, botId), gte(usageEvents.occurredAt, since)),
				),
			),
		chatSpend: (organizationId, chats, since) =>
			chats.length === 0
				? Effect.succeed(0)
				: stored(
						spend(
							and(
								eq(usageEvents.organizationId, organizationId),
								inArray(usageEvents.chatId, [...chats]),
								gte(usageEvents.occurredAt, since),
							),
						),
					),
		reserve: (call, attribution, estimate, identity) =>
			stored(
				client.withTransaction(
					Effect.gen(function* () {
						// Lock the execution before the budget. An old node cannot reserve after takeover.
						if (identity !== undefined) {
							const [execution] = yield* db
								.select()
								.from(executions)
								.where(eq(executions.id, identity.executionId))
								.for("update")
							const [sending] = yield* db
								.select()
								.from(executionCalls)
								.where(
									and(
										eq(executionCalls.id, identity.id),
										eq(executionCalls.executionId, identity.executionId),
										eq(executionCalls.generation, identity.generation),
										eq(executionCalls.status, "sending"),
									),
								)
							if (
								execution?.generation !== identity.generation ||
								execution.status !== "running" ||
								execution.organizationId !== call.organizationId ||
								sending === undefined
							)
								return yield* BillingStorageError.make({
									cause: "The model call has no current execution owner.",
								})
						}
						// One lock makes budget checks and reservations agree across nodes.
						yield* client`select pg_advisory_xact_lock(hashtextextended(${call.organizationId}, 42))`
						const id =
							identity?.id ?? Execution.CallId.make(yield* newId("usage_"))
						const [prior] = yield* db
							.select()
							.from(usageEvents)
							.where(eq(usageEvents.id, id))
						if (prior !== undefined) {
							if (
								prior.organizationId !== call.organizationId ||
								prior.providerId !== call.providerId ||
								prior.modelId !== call.modelId ||
								prior.providerOwner !== call.providerOwner ||
								prior.userId !== (attribution.userId ?? null) ||
								prior.tokenId !== (attribution.tokenId ?? null) ||
								prior.executionId !== (identity?.executionId ?? null) ||
								prior.chatId !== (attribution.chatId ?? null) ||
								prior.turnId !== (attribution.turnId ?? null) ||
								prior.botId !== (attribution.botId ?? null) ||
								prior.source !== attribution.source
							)
								return yield* BillingStorageError.make({
									cause: "The model call ID belongs to another call.",
								})
							return { id, startedAt: prior.startedAt ?? prior.occurredAt }
						}
						const now = yield* Clock.currentTimeMillis
						const price = yield* priceAtFromStorage(
							call.providerId,
							call.modelId,
							now,
						)
						const reserved = Option.match(price, {
							onNone: () => 0,
							onSome: (price) =>
								costOf(estimate, ratesOf(price.schedule, estimate, now)),
						})
						const rows = yield* db
							.select()
							.from(budgets)
							.where(
								and(
									eq(budgets.organizationId, call.organizationId),
									eq(budgets.mode, "hard"),
								),
							)
						for (const budget of rows) {
							const scope = yield* decodeScope(budget.scopeKind)
							if (scopeIdOf(scope, call, attribution) !== budget.scopeId)
								continue
							const column = scopeColumn(scope)
							const start = periodStart(yield* decodePeriod(budget.period), now)
							const [sum] = yield* db
								.select({
									spent:
										sql<number>`coalesce(sum(case when ${usageEvents.occurredAt} >= ${start} then ${usageEvents.costMicros} else 0 end + ${usageEvents.reservedMicros}), 0)`.mapWith(
											Number,
										),
								})
								.from(usageEvents)
								.where(
									and(
										eq(usageEvents.organizationId, call.organizationId),
										column === undefined
											? undefined
											: eq(column, budget.scopeId),
									),
								)
							const used = sum?.spent ?? 0
							if (
								used >= budget.limitMicros ||
								used + reserved > budget.limitMicros
							)
								return yield* SpendingBlocked.make({
									reason: "budget",
									budgetId: budget.id,
									message: `The ${budget.period} budget of this ${budget.scopeKind} has no room for this call.`,
								})
						}
						if (call.providerOwner === "platform") {
							const [credits] = yield* db
								.select()
								.from(organizationCredits)
								.where(
									eq(organizationCredits.organizationId, call.organizationId),
								)
								.for("update")
							const [sum] = yield* db
								.select({ held: sumOf(usageEvents.reservedMicros) })
								.from(usageEvents)
								.where(
									and(
										eq(usageEvents.organizationId, call.organizationId),
										eq(usageEvents.providerOwner, "platform"),
									),
								)
							const held = sum?.held ?? 0
							if (
								credits?.enabled === true &&
								(credits.balanceMicros <= held ||
									credits.balanceMicros < held + reserved)
							)
								return yield* SpendingBlocked.make({
									reason: "credits",
									message: "The organization has no credits for this call.",
								})
						}
						yield* db.insert(usageEvents).values({
							id,
							executionId: identity?.executionId ?? null,
							organizationId: call.organizationId,
							status: "pending",
							startedAt: now,
							occurredAt: now,
							estimatedMicros: reserved,
							reservedMicros: reserved,
							estimatedTokens:
								estimate.inputUncached +
								estimate.inputCacheRead +
								estimate.inputCacheWrite +
								estimate.outputText +
								estimate.outputReasoning,
							source: attribution.source,
							chatId: attribution.chatId ?? null,
							turnId: attribution.turnId ?? null,
							botId: attribution.botId ?? null,
							userId: attribution.userId ?? null,
							tokenId: attribution.tokenId ?? null,
							providerId: call.providerId,
							providerOwner: call.providerOwner,
							modelId: call.modelId,
							inputUncached: 0,
							inputCacheRead: 0,
							inputCacheWrite: 0,
							outputText: 0,
							outputReasoning: 0,
							costMicros: 0,
							charged: false,
							priceSchedule: yield* Option.match(price, {
								onNone: () => Effect.succeed(null),
								onSome: (price) => encodeSchedule(price.schedule),
							}),
							priceId: Option.match(price, {
								onNone: () => null,
								onSome: (price) => price.id,
							}),
						})
						return { id, startedAt: now }
					}),
				),
			),
		record: (id, used) =>
			stored(
				client.withTransaction(
					Effect.gen(function* () {
						const [row] = yield* db
							.select()
							.from(usageEvents)
							.where(eq(usageEvents.id, id))
							.for("update")
						if (row === undefined)
							return yield* BillingStorageError.make({
								cause: "The model call has no reservation.",
							})
						if (row.status === "confirmed") {
							if (
								row.inputUncached !== used.inputUncached ||
								row.inputCacheRead !== used.inputCacheRead ||
								row.inputCacheWrite !== used.inputCacheWrite ||
								row.outputText !== used.outputText ||
								row.outputReasoning !== used.outputReasoning
							)
								return yield* BillingStorageError.make({
									cause: "The model call already has different usage.",
								})
							return
						}
						const now = yield* Clock.currentTimeMillis
						const startedAt = row.startedAt ?? row.occurredAt
						// The reservation keeps its price even when the provider is removed.
						if (row.priceId !== null && row.priceSchedule === null)
							return yield* BillingStorageError.make({
								cause: "The reserved price is missing.",
							})
						const cost =
							row.priceSchedule === null
								? 0
								: costOf(
										used,
										ratesOf(
											yield* decodeSchedule(row.priceSchedule),
											used,
											startedAt,
										),
									)
						const [credits] =
							row.providerOwner === "platform"
								? yield* db
										.select()
										.from(organizationCredits)
										.where(
											eq(
												organizationCredits.organizationId,
												row.organizationId,
											),
										)
										.for("update")
								: []
						const charged = credits?.enabled === true
						yield* db
							.update(usageEvents)
							.set({
								...used,
								status: "confirmed",
								occurredAt: now,
								reservedMicros: 0,
								costMicros: cost,
								charged,
							})
							.where(eq(usageEvents.id, id))
						if (charged && cost > 0)
							yield* db
								.update(organizationCredits)
								.set({
									balanceMicros: sql`${organizationCredits.balanceMicros} - ${cost}`,
									updatedAt: now,
								})
								.where(
									eq(organizationCredits.organizationId, row.organizationId),
								)
					}),
				),
			),
		unknown: (id) =>
			stored(
				db
					.update(usageEvents)
					.set({ status: "unknown", reservedMicros: 0 })
					.where(
						and(
							eq(usageEvents.id, id),
							inArray(usageEvents.status, ["pending", "unknown"]),
						),
					)
					.pipe(Effect.asVoid),
			),
		releaseExecution: (owner) =>
			stored(
				client.withTransaction(
					Effect.gen(function* () {
						const [execution] = yield* db
							.select()
							.from(executions)
							.where(eq(executions.id, owner.executionId))
							.for("update")
						if (execution?.generation !== owner.generation) return false
						const terminal = Execution.isTerminal(
							yield* decodeStored(Execution.Status)(execution.status),
						)
						yield* db
							.update(usageEvents)
							.set({ status: "unknown", reservedMicros: 0 })
							.where(
								and(
									eq(usageEvents.executionId, owner.executionId),
									inArray(usageEvents.status, ["pending", "unknown"]),
									terminal
										? undefined
										: inArray(
												usageEvents.id,
												db
													.select({ id: executionCalls.id })
													.from(executionCalls)
													.where(
														and(
															eq(executionCalls.executionId, owner.executionId),
															lt(executionCalls.generation, owner.generation),
														),
													),
											),
								),
							)
						return true
					}),
				),
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
						.orderBy(
							modelPrices.modelId,
							desc(modelPrices.effectiveFrom),
							desc(modelPrices.position),
						)
					return yield* Effect.forEach(rows, priceView)
				}),
			),
		setPrice: (providerId, input, createdBy) =>
			stored(
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const schedule = yield* encodeSchedule({
						timeZone: input.timeZone ?? "UTC",
						tiers: input.tiers,
						periods: input.periods ?? [],
					})
					const [row] = yield* db
						.insert(modelPrices)
						.values({
							id: yield* newId("price_"),
							providerId,
							modelId: input.model,
							effectiveFrom: now,
							schedule,
							createdBy,
							createdAt: now,
						})
						.returning()
					return yield* priceView(row!)
				}),
			),
		currentPrices: (providerIds) =>
			stored(
				Effect.gen(function* () {
					if (providerIds.length === 0)
						return HashMap.empty<
							readonly [providerId: string, modelId: string],
							BillingApi.ModelPrice
						>()
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
							desc(modelPrices.position),
						)
					return HashMap.fromIterable(
						yield* Effect.forEach(rows, (row) =>
							Effect.map(
								priceView(row),
								(price) =>
									[[row.providerId, row.modelId] as const, price] as const,
							),
						),
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
							pendingCalls: 0,
							unknownCalls: 0,
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
					const after =
						page.after === undefined
							? undefined
							: yield* Effect.fromOption(decodeCursor(page.after)).pipe(
									Effect.catchTag("NoSuchElementError", () =>
										Effect.fail(
											BillingApi.UsageQueryInvalid.make({
												message:
													"`after` is not a `next` value from this list.",
											}),
										),
									),
								)
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
						items: yield* Effect.forEach(items, eventView),
						next:
							rows.length > page.limit && last !== undefined
								? yield* encodeCursor({ at: last.occurredAt, id: last.id })
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
									id: yield* newId("grant_"),
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
					if (row === undefined)
						return yield* BillingApi.BudgetNotFound.make({
							budgetId: BillingApi.BudgetId.make(id),
						})
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
							id: yield* newId("budget_"),
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
							if (row === undefined)
								return yield* BillingApi.BudgetNotFound.make({
									budgetId: BillingApi.BudgetId.make(id),
								})
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
					if (deleted.length === 0)
						return yield* BillingApi.BudgetNotFound.make({
							budgetId: BillingApi.BudgetId.make(id),
						})
				}),
			),
	})
})

export const layer = Layer.effect(Billing, make)
