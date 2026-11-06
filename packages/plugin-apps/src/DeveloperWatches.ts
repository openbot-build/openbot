import { ServiceId, type ServiceIdentity } from "@openbot-build/domain/Identity"
import {
	type ServiceExecution,
	Store,
	commandActor,
	transactionFailures,
	type Key,
	type Fence,
} from "@openbot-build/server-execution/Store"
import { type Developers, Execution } from "@openbot-build/domain"
import type { SecretStorageError } from "@openbot-build/server-kernel/Secrets"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import { type SqlError, SqlClient } from "effect/sql"
import { and, eq } from "drizzle-orm"
import { Array as Arr, Context, Effect, Layer, Option, Schema } from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { Hex } from "effect/encoding"
import * as Db from "@openbot-build/server-database/Database"
import { developerWatches } from "@openbot-build/server-database/Schema"
import { instanceNamespace } from "@openbot-build/apps-contract/apps/DeveloperRows"

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
export interface Service {
	readonly ensure: (
		ref: Reference,
		due: number,
	) => Effect.Effect<
		{ namespace: string; id: Execution.Id },
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly load: (
		key: Key,
		lock?: boolean,
	) => Effect.Effect<
		{
			saved: ServiceExecution
			ref: Reference
			row: typeof developerWatches.$inferSelect
		},
		Execution.Forbidden | Execution.NotFound | Developers.StorageFailure
	>
	readonly authorize: (
		key: Key,
	) => Effect.Effect<
		void,
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly request: (
		ref: Reference,
	) => Effect.Effect<
		{ key: { namespace: string; id: Execution.Id }; revision: number },
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Developers.StorageFailure
	>
	readonly complete: <A, E, R>(
		fence: Fence,
		revision: number,
		change: Effect.Effect<
			{ readonly nextCheckAt: number; readonly value: A },
			E,
			R
		>,
	) => Effect.Effect<
		A | undefined,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Schema.SchemaError
		| SecretStorageError
		| Execution.StorageError
		| Exclude<
				Exclude<E, EffectDrizzleQueryError | SqlError.SqlError>,
				EffectDrizzleQueryError | SqlError.SqlError
		  >,
		R
	>
}

export class DeveloperWatches extends Context.Service<
	DeveloperWatches,
	Service
>()("@openbot-build/plugin-apps/DeveloperWatches") {}

const make = Effect.gen(function* () {
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const store = yield* Store
	const crypto = yield* SecureRandom.SecureRandom
	const hashes = yield* Digest.Digest
	const namespace = yield* instanceNamespace
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
				const token = yield* crypto.uuidV7().pipe(Effect.orDie)
				const resource = Hex.encode(
					yield* hashes
						.digest(
							Digest.sha256,
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
						`check:${yield* crypto.uuidV7().pipe(Effect.orDie)}`,
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
	return DeveloperWatches.of({ ensure, load, authorize, request, complete })
})

export const layer = Layer.effect(DeveloperWatches, make)
