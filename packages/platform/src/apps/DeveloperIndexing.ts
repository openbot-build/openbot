import { randomUUID } from "node:crypto"
import { DeveloperApi as Api } from "@openbot-build/platform-api"
import {
	Array as Arr,
	Clock,
	Context,
	Effect,
	Layer,
	Match,
	Option,
} from "effect"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import {
	DeveloperRepository,
	type IndexRequestRecord,
} from "./DeveloperRepository.ts"
import { AppInspections } from "./AppInspections.ts"
import { IndexWorkRepository } from "./IndexWorkRepository.ts"
import { Governance } from "./Governance.ts"

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
>()("@openbot-build/platform/apps/DeveloperIndexing") {}
export const make: Effect.Effect<
	typeof DeveloperIndexing.Service,
	never,
	| DeveloperAccess
	| DeveloperRepository
	| AppInspections
	| IndexWorkRepository
	| Governance
> = Effect.gen(function* () {
	const records = yield* DeveloperRepository
	const access = yield* DeveloperAccess
	const inspections = yield* AppInspections
	const jobs = yield* IndexWorkRepository
	const governance = yield* Governance
	const read = (record: IndexRequestRecord) =>
		Effect.gen(function* () {
			yield* access.authorize(record.owner, record.value.cardUrl)
			const job = yield* jobs
				.get(record.value.cardUrl, record.value.generation)
				.pipe(Effect.mapError(() => Api.DeveloperUnavailable.make({})))
			return {
				...record.value,
				status: Option.match(job, {
					onNone: () => "Accepted" as const,
					onSome: (job) => job.status,
				}),
				check: Option.getOrNull(
					Option.flatMapNullishOr(job, (job) => job.check),
				),
				restriction: Option.getOrNull(governance.find(record.value.cardUrl)),
			} satisfies Api.IndexRequest
		})
	return DeveloperIndexing.of({
		get: (owner, id) =>
			Effect.gen(function* () {
				const record = yield* records.indexing.get(id)
				if (record.owner !== owner) return yield* Api.DeveloperNotFound.make({})
				return yield* read(record)
			}),
		list: (owner, cardUrl) =>
			Effect.gen(function* () {
				if (cardUrl !== undefined) yield* access.authorize(owner, cardUrl)
				const requests = yield* records.indexing.list({
					owner,
					...(cardUrl === undefined ? {} : { scope: cardUrl }),
				})
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
					Effect.fromOption,
					Effect.mapError(() =>
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
				return yield* records.transaction(
					"indexing:" + cardUrl,
					Effect.gen(function* () {
						yield* access.authorize(owner, cardUrl, true)
						const job = yield* jobs
							.enqueue(cardUrl, app.candidate.sources)
							.pipe(Effect.mapError(() => Api.DeveloperUnavailable.make({})))
						const previous = (yield* records.indexing.list({
							owner,
							scope: cardUrl,
						})).find((record) => record.value.generation === job.generation)
						if (previous !== undefined) return yield* read(previous)
						const value: Api.IndexRequest = {
							id: yield* Effect.sync(randomUUID),
							cardUrl,
							generation: job.generation,
							acceptedAt: yield* Clock.currentTimeMillis,
							status: "Accepted",
							check: null,
							restriction: null,
						}
						yield* records.indexing.put(value.id, owner, cardUrl, {
							owner,
							value,
						})
						return value
					}),
				)
			}),
	})
})
export const layer = Layer.effect(DeveloperIndexing, make)
