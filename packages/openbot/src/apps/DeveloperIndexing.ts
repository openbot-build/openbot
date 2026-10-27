import { Developers } from "@openbot-build/domain"
import { Authorization, Caller, Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	HashMap,
	Layer,
	Option,
	Schema,
	Stream,
} from "effect"
import { and, eq } from "drizzle-orm"
import { developerIndexRequests } from "../database/Schema.ts"
import * as Db from "../database/Database.ts"
import * as Check from "../authorization/Check.ts"
import * as Failures from "../errors/Failures.ts"
import {
	Store,
	storage,
	transactionFailures,
	type Key,
	type Fence,
} from "../execution/Store.ts"
import type { Authorize } from "../execution/Engine.ts"
import { Observation } from "../execution/Observation.ts"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import * as Rows from "./DeveloperRows.ts"
import { IndexNamespace } from "./IndexNamespace.ts"
import { IndexWork } from "./IndexWork.ts"
import { Governance } from "./Governance.ts"
import { ownerKey } from "./StoredConnections.ts"

export const workflowName = "openbot.index-request"
const Input = Schema.Struct({
	cardUrl: Schema.String,
	generation: Schema.String,
	watch: Schema.Struct({ namespace: Schema.String, id: Execution.Id }),
})
const sameCaller = Schema.toEquivalence(Caller)
export const make = Effect.gen(function* () {
	const access = yield* DeveloperAccess
	const checks = yield* Check.make
	const crypto = yield* Crypto.Crypto
	const db = yield* Db.make
	const namespace = yield* IndexNamespace
	const store = yield* Store
	const index = yield* IndexWork
	const observation = yield* Observation
	const governance = yield* Governance
	const requestWhere = (owner: string, cardUrl?: string) =>
		and(
			eq(developerIndexRequests.namespace, namespace),
			eq(developerIndexRequests.owner, owner),
			cardUrl === undefined
				? undefined
				: eq(developerIndexRequests.cardUrl, cardUrl),
		)
	const check = (actor: Caller, cardUrl: string, write: boolean) =>
		Effect.gen(function* () {
			yield* checks.check(actor, {
				action: "publish",
				resource: Authorization.App.make({
					organizationId: actor.organizationId,
					ownerUserId: actor.userId,
				}),
			})
			yield* access.authorize(ownerKey(actor), cardUrl, write)
		}).pipe(
			Effect.catchTags({
				Forbidden: () => Effect.fail(Execution.Forbidden.make({})),
				Pending: () => Effect.fail(Execution.Forbidden.make({})),
				ExecutionConflict: (cause) =>
					Effect.fail(Execution.StorageError.make({ cause })),
				ExecutionKeyConflict: (cause) =>
					Effect.fail(Execution.StorageError.make({ cause })),
				DeveloperForbidden: () => Effect.fail(Execution.Forbidden.make({})),
				DeveloperNotFound: () => Effect.fail(Execution.Forbidden.make({})),
			}),
			storage,
		)
	const read = (
		record: typeof developerIndexRequests.$inferSelect,
		restrictions?: Effect.Success<typeof governance.snapshot>,
	) =>
		Effect.gen(function* () {
			yield* access.authorize(record.owner, record.cardUrl)
			if (record.executionId === null)
				return yield* Effect.die(
					"The Index request has no execution. Complete the data move first.",
				)
			const job = yield* index
				.job(record.cardUrl, record.generation)
				.pipe(
					Failures.replace("Could not read the Public Index job.", () =>
						Developers.DeveloperUnavailable.make({}),
					),
				)
			return {
				id: record.id,
				executionId: Execution.Id.make(record.executionId),
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
				restriction: Option.getOrNull(
					HashMap.get(
						restrictions ??
							(yield* governance.snapshot.pipe(
								Failures.replace("Could not read App restrictions.", () =>
									Developers.DeveloperUnavailable.make({}),
								),
							)),
						new URL(record.cardUrl).href,
					),
				),
			} satisfies Developers.IndexRequest
		})
	const get = (owner: string, id: string) =>
		Effect.gen(function* () {
			const record = Arr.head(
				yield* Rows.stored(
					db
						.select()
						.from(developerIndexRequests)
						.where(and(requestWhere(owner), eq(developerIndexRequests.id, id))),
				),
			)
			if (Option.isNone(record))
				return yield* Developers.DeveloperNotFound.make({})
			return yield* read(record.value)
		})
	const load = (key: Key) =>
		Effect.gen(function* () {
			const execution = yield* store.loadMember(key)
			const input = yield* Schema.decodeUnknownEffect(Input)(execution.input)
			if (
				execution.workflow !== workflowName ||
				execution.record.resource.kind !== "IndexRequest" ||
				key.namespace !== ownerKey(execution.identity.owner)
			)
				return yield* Execution.Forbidden.make({})
			return { execution, input }
		}).pipe(storage)
	const authorize: Authorize = (key, actor, mode) =>
		Effect.gen(function* () {
			const saved = yield* load(key)
			if (
				ownerKey(actor) !== ownerKey(saved.execution.identity.owner) ||
				((mode === "advance" || mode === "replay") &&
					!sameCaller(actor, saved.execution.identity.actor))
			)
				return yield* Execution.Forbidden.make({})
			yield* check(actor, saved.input.cardUrl, mode !== "read")
		})
	const request = Effect.fn("DeveloperIndexing.request")(function* (
		actor: Caller,
		cardUrl: string,
		commandKey: Execution.CommandKey,
	) {
		yield* check(actor, cardUrl, true)
		const owner = ownerKey(actor)
		const receipt = yield* store.accept(
			owner,
			commandKey,
			{ actor, body: { kind: "index-request", cardUrl } },
			(create) =>
				Effect.gen(function* () {
					yield* check(actor, cardUrl, true)
					const restriction = yield* governance.find(cardUrl).pipe(storage)
					if (Option.isSome(restriction))
						return yield* Developers.DeveloperRestricted.make({
							restriction: restriction.value,
						})
					const app = yield* Rows.getApp(db, namespace, cardUrl)
					const watch = yield* index.request(cardUrl, app.candidate.sources)
					const id = yield* crypto.randomUUIDv4()
					const key = yield* create({
						workflow: workflowName,
						identity: {
							owner: {
								organizationId: actor.organizationId,
								userId: actor.userId,
							},
							actor,
						},
						resource: { kind: "IndexRequest", id },
						input: {
							cardUrl,
							generation: watch.job.generation,
							watch: watch.execution,
						},
					})
					yield* db.insert(developerIndexRequests).values({
						namespace,
						owner,
						id,
						executionId: key.id,
						cardUrl,
						generation: watch.job.generation,
						acceptedAt: yield* Clock.currentTimeMillis,
					})
					return { executionId: key.id, start: true }
				}),
		)
		const saved = yield* store.get({
			namespace: owner,
			id: receipt.executionId,
		})
		return yield* get(owner, saved.resource.id)
	}, transactionFailures)
	const list = (owner: string, cardUrl?: string) =>
		Effect.gen(function* () {
			if (cardUrl !== undefined) yield* access.authorize(owner, cardUrl)
			const requests = yield* Rows.stored(
				db
					.select()
					.from(developerIndexRequests)
					.where(requestWhere(owner, cardUrl))
					.orderBy(developerIndexRequests.id),
			)
			const restrictions = yield* governance.snapshot.pipe(
				Failures.replace("Could not read App restrictions.", () =>
					Developers.DeveloperUnavailable.make({}),
				),
			)
			return yield* Effect.forEach(requests, (record) =>
				read(record, restrictions).pipe(
					Effect.asSome,
					Effect.catchTag("DeveloperNotFound", () => Effect.succeedNone),
				),
			).pipe(Effect.map(Arr.getSomes))
		})
	const work = (fence: Fence) =>
		Effect.gen(function* () {
			const saved = yield* load(fence)
			yield* authorize(fence, saved.execution.identity.actor, "advance")
			while (true) {
				// Read the cursor first. A result saved during the next read is still in the log.
				const watch = yield* store.get(saved.input.watch)
				const job = yield* index.job(
					saved.input.cardUrl,
					saved.input.generation,
				)
				if (Option.isSome(job) && job.value.status === "Completed") {
					yield* authorize(fence, saved.execution.identity.actor, "advance")
					yield* store.commit(
						fence,
						{
							status: "completed",
							events: [
								{ _tag: "Result", resource: saved.execution.record.resource },
							],
						},
						Effect.void,
					)
					return
				}
				if (Execution.isTerminal(watch.status)) {
					if (watch.failure !== null) return yield* Effect.fail(watch.failure)
					yield* store.commit(fence, { status: "interrupted" }, Effect.void)
					return
				}
				yield* observation
					.observe(saved.input.watch, watch.sequence)
					.pipe(Stream.take(1), Stream.runDrain)
				yield* authorize(fence, saved.execution.identity.actor, "advance")
			}
		})
	return { request, list, get, authorize, work }
})
export class DeveloperIndexing extends Context.Service<
	DeveloperIndexing,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/apps/DeveloperIndexing") {}
export const layer = Layer.effect(DeveloperIndexing, make)
