import { DeveloperApi as Api } from "@openbot-build/api"
import {
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Match,
	Option,
} from "effect"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import { AppInspections } from "./AppInspections.ts"
import { PgClient } from "@effect/sql-pg"
import { and, eq } from "drizzle-orm"
import { developerIndexRequests } from "../database/Schema.ts"
import * as Rows from "./DeveloperRows.ts"
import { IndexNamespace } from "./IndexNamespace.ts"
import * as IndexWork from "./IndexWork.ts"
import { Governance } from "./Governance.ts"
import * as Db from "../database/Database.ts"
import * as Failures from "../app/Failures.ts"

export class DeveloperIndexing extends Context.Service<
	DeveloperIndexing,
	{
		readonly request: (
			owner: string,
			cardUrl: string,
		) => Effect.Effect<Api.IndexRequest, Api.Failure>
		readonly list: (
			owner: string,
			cardUrl?: string,
		) => Effect.Effect<ReadonlyArray<Api.IndexRequest>, Api.Failure>
		readonly get: (
			owner: string,
			id: string,
		) => Effect.Effect<Api.IndexRequest, Api.Failure>
	}
>()("@openbot-build/openbot/apps/DeveloperIndexing") {}
export const make: Effect.Effect<
	typeof DeveloperIndexing.Service,
	never,
	| DeveloperAccess
	| AppInspections
	| PgClient.PgClient
	| Governance
	| Crypto.Crypto
> = Effect.gen(function* () {
	const access = yield* DeveloperAccess
	const inspections = yield* AppInspections
	const crypto = yield* Crypto.Crypto
	const db = yield* Db.make
	const namespace = yield* IndexNamespace
	const inTransaction = Rows.transaction(yield* PgClient.PgClient)
	const requestWhere = (owner: string, cardUrl?: string) =>
		and(
			eq(developerIndexRequests.namespace, namespace),
			eq(developerIndexRequests.owner, owner),
			cardUrl === undefined
				? undefined
				: eq(developerIndexRequests.cardUrl, cardUrl),
		)
	const governance = yield* Governance
	const read = (record: typeof developerIndexRequests.$inferSelect) =>
		Effect.gen(function* () {
			yield* access.authorize(record.owner, record.cardUrl)
			const job = yield* IndexWork.job(
				db,
				namespace,
				record.cardUrl,
				record.generation,
			).pipe(
				Failures.replace("Could not read the Public Index job.", () =>
					Api.DeveloperUnavailable.make({}),
				),
			)
			return {
				id: record.id,
				cardUrl: record.cardUrl,
				generation: record.generation,
				acceptedAt: record.acceptedAt,
				status: Option.match(job, {
					onNone: () => "Accepted" as const,
					onSome: (job) => job.status,
				}),
				check: Option.getOrNull(
					Option.flatMapNullishOr(job, (job) => job.check),
				),
				restriction: Option.getOrNull(governance.find(record.cardUrl)),
			} satisfies Api.IndexRequest
		})
	return DeveloperIndexing.of({
		get: (owner, id) =>
			Effect.gen(function* () {
				const record = (yield* Rows.stored(
					db
						.select()
						.from(developerIndexRequests)
						.where(and(requestWhere(owner), eq(developerIndexRequests.id, id))),
				))[0]
				if (record === undefined) return yield* Api.DeveloperNotFound.make({})
				return yield* read(record)
			}),
		list: (owner, cardUrl) =>
			Effect.gen(function* () {
				if (cardUrl !== undefined) yield* access.authorize(owner, cardUrl)
				const requests = yield* Rows.stored(
					db
						.select()
						.from(developerIndexRequests)
						.where(requestWhere(owner, cardUrl))
						.orderBy(developerIndexRequests.id),
				)
				// Hide requests for Apps that the owner can no longer see.
				return yield* Effect.forEach(requests, (record) =>
					read(record).pipe(
						Effect.asSome,
						Effect.catchTag("DeveloperNotFound", () => Effect.succeedNone),
					),
				).pipe(Effect.map(Arr.getSomes))
			}),
		request: (owner, cardUrl) =>
			Effect.gen(function* () {
				yield* access.authorize(owner, cardUrl, true)
				yield* Option.match(governance.find(cardUrl), {
					onNone: () => Effect.void,
					onSome: (restriction) =>
						Effect.fail(Api.DeveloperRestricted.make({ restriction })),
				})
				const report = yield* inspections.inspect(cardUrl)
				const app = yield* Arr.findFirst(
					report.apps,
					(app) => app.candidate.cardUrl === cardUrl,
				).pipe(
					Effect.fromOption(() =>
						Api.DeveloperConflict.make({ reason: "PublicationUnavailable" }),
					),
				)
				yield* Match.value(app.eligibility).pipe(
					Match.tagsExhaustive({
						Eligible: () => Effect.void,
						Excluded: (value) =>
							Effect.fail(Api.DeveloperConflict.make({ reason: value.reason })),
						Unconfirmed: (value) =>
							Effect.fail(Api.DeveloperConflict.make({ reason: value.reason })),
					}),
				)
				return yield* inTransaction(
					Effect.gen(function* () {
						yield* access.authorize(owner, cardUrl, true)
						const job = yield* IndexWork.enqueue(
							db,
							namespace,
							cardUrl,
							app.candidate.sources,
						).pipe(
							Effect.provideService(Crypto.Crypto, crypto),
							Failures.replace("Could not add the Public Index job.", () =>
								Api.DeveloperUnavailable.make({}),
							),
						)
						const value: Api.IndexRequest = {
							id: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
							cardUrl,
							generation: job.generation,
							acceptedAt: yield* Clock.currentTimeMillis,
							status: "Accepted",
							check: null,
							restriction: null,
						}
						// A job that still waits keeps its generation. Then the owner has asked already.
						const inserted = yield* Rows.stored(
							db
								.insert(developerIndexRequests)
								.values({
									namespace,
									owner,
									id: value.id,
									cardUrl,
									generation: value.generation,
									acceptedAt: value.acceptedAt,
								})
								.onConflictDoNothing()
								.returning({ id: developerIndexRequests.id }),
						)
						if (inserted.length === 1) return value
						const previous = (yield* Rows.stored(
							db
								.select()
								.from(developerIndexRequests)
								.where(
									and(
										requestWhere(owner, cardUrl),
										eq(developerIndexRequests.generation, job.generation),
									),
								),
						))[0]
						if (previous === undefined)
							return yield* Effect.die(
								"An Index request blocked the insert, but OpenBot can not read it.",
							)
						return yield* read(previous)
					}),
				)
			}),
	})
})
export const layer = Layer.effect(DeveloperIndexing, make)
