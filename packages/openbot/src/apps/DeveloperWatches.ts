import {
	Execution,
	ServiceId,
	type ServiceIdentity,
} from "@openbot-build/domain"
import { and, eq } from "drizzle-orm"
import {
	Array as Arr,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Schema,
} from "effect"
import { Hex } from "effect/encoding"
import { SqlClient } from "effect/sql"
import * as Db from "../database/Database.ts"
import { developerWatches } from "../database/Schema.ts"
import {
	Store,
	commandActor,
	transactionFailures,
	type Key,
	type Fence,
} from "../execution/Store.ts"
import { IndexNamespace } from "./IndexNamespace.ts"

export const workflowName = "openbot.developer-watch"
export const serviceId = ServiceId.make("developer-monitor")
export const identity: ServiceIdentity = {
	owner: { kind: "platform" },
	actor: { kind: "service", serviceId },
}
export const Reference = Schema.Struct({
	kind: Schema.Literals(["App", "Proof"]),
	id: Schema.String,
})
export type Reference = typeof Reference.Type
const Input = Schema.Struct({ namespace: Schema.String, ref: Reference })
export const nextSignal = (revision: number) => `check:${revision}`

/** The domain holds the check cursor. The shared engine holds its owner and timer. */
const make = Effect.gen(function* () {
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const store = yield* Store
	const crypto = yield* Crypto.Crypto
	const namespace = yield* IndexNamespace
	const executionNamespace = `developer-monitor:${namespace}`
	const where = (ref: Reference) =>
		and(
			eq(developerWatches.namespace, namespace),
			eq(developerWatches.kind, ref.kind),
			eq(developerWatches.resourceId, ref.id),
		)
	const row = (ref: Reference, lock = false) => {
		const query = db.select().from(developerWatches).where(where(ref))
		return (lock ? query.for("update") : query).pipe(Effect.map(Arr.head))
	}
	const ensure = Effect.fn("DeveloperWatches.ensure")(function* (
		ref: Reference,
		due: number,
	) {
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* db
					.insert(developerWatches)
					.values({
						namespace,
						kind: ref.kind,
						resourceId: ref.id,
						nextCheckAt: due,
					})
					.onConflictDoNothing()
				const found = yield* row(ref, true)
				if (Option.isNone(found))
					return yield* Effect.die(
						"The developer check row is missing after insert.",
					)
				const current = found.value
				if (current.executionId !== null) {
					const key = {
						namespace: executionNamespace,
						id: Execution.Id.make(current.executionId),
					}
					if (!Execution.isTerminal((yield* store.get(key)).status)) return key
				}
				const token = yield* crypto.randomUUIDv4().pipe(Effect.orDie)
				const resource = Hex.encode(
					yield* crypto
						.digest(
							"SHA-256",
							new TextEncoder().encode(`${ref.kind}:${ref.id}`),
						)
						.pipe(Effect.orDie),
				)
				const receipt = yield* store.submit(
					executionNamespace,
					Execution.CommandKey.make(`watch:${token}`),
					{
						workflow: workflowName,
						identity,
						resource: { kind: "DeveloperWatch", id: resource },
						input: { namespace, ref },
					},
				)
				yield* db
					.update(developerWatches)
					.set({ executionId: receipt.executionId })
					.where(where(ref))
				return { namespace: executionNamespace, id: receipt.executionId }
			}),
		)
	}, transactionFailures)
	const load = Effect.fn("DeveloperWatches.load")(function* (
		key: Key,
		lock = false,
	) {
		const saved = yield* store.loadService(key, serviceId)
		const input = yield* Schema.decodeUnknownEffect(Input)(saved.input)
		if (
			key.namespace !== executionNamespace ||
			input.namespace !== namespace ||
			saved.identity.owner.kind !== "platform"
		)
			return yield* Execution.Forbidden.make({})
		const found = yield* row(input.ref, lock)
		if (Option.isNone(found) || found.value.executionId !== key.id)
			return yield* Execution.NotFound.make({ id: key.id })
		return { saved, ref: input.ref, row: found.value }
	}, transactionFailures)
	const authorize = (key: Key) =>
		load(key).pipe(Effect.asVoid, Effect.catchTag("SchemaError", Effect.die))
	const request = Effect.fn("DeveloperWatches.request")(function* (
		ref: Reference,
	) {
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				const key = yield* ensure(ref, 0)
				const current = yield* load(key, true)
				yield* db
					.update(developerWatches)
					.set({ nextCheckAt: 0 })
					.where(where(ref))
				yield* store.notify(
					key,
					Execution.CommandKey.make(
						`check:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
					),
					commandActor(identity),
					nextSignal(current.row.revision),
				)
				return { key, revision: current.row.revision }
			}),
		)
	}, transactionFailures)
	const complete = <A, E, R>(
		fence: Fence,
		revision: number,
		change: Effect.Effect<
			{ readonly nextCheckAt: number; readonly value: A },
			E,
			R
		>,
	) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const current = yield* load(fence, true)
					if (current.saved.generation !== fence.generation)
						return yield* Execution.Conflict.make({ id: fence.id })
					if (current.row.revision > revision) return
					if (current.row.revision !== revision)
						return yield* Execution.Conflict.make({ id: fence.id })
					return yield* store.commit(
						fence,
						{
							events: [
								{
									_tag: "Checkpoint",
									resource: current.saved.record.resource,
									revision: revision + 1,
								},
							],
						},
						Effect.gen(function* () {
							const result = yield* change
							yield* db
								.update(developerWatches)
								.set({
									revision: revision + 1,
									nextCheckAt: result.nextCheckAt,
								})
								.where(where(current.ref))
							return result.value
						}),
					)
				}),
			)
			.pipe(transactionFailures)
	return { ensure, load, authorize, request, complete }
})
export class DeveloperWatches extends Context.Service<
	DeveloperWatches,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/apps/DeveloperWatches") {}
export const layer = Layer.effect(DeveloperWatches, make)
