import { Execution, ExecutionIdentity } from "@openbot-build/domain"
import { and, eq } from "drizzle-orm"
import { Array as Arr, Effect, Option, Schema } from "effect"
import * as Db from "../database/Database.ts"
import { toolOrigins, executions } from "../database/ExecutionSchema.ts"
import { Store, storage, type Fence, type Key } from "../execution/Store.ts"
import * as ToolRecords from "./ToolRecords.ts"

const sameIdentity = Schema.toEquivalence(ExecutionIdentity)
const samePath = Schema.toEquivalence(Schema.Array(Schema.String))
export const contains = (
	parent: ReadonlyArray<string>,
	child: ReadonlyArray<string>,
) =>
	parent.length <= child.length &&
	Arr.every(parent, (part, index) => part === child[index])

/** A feature execution points to an accepted tool, not to the Chat's current step. */
export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const store = yield* Store
	const tools = yield* ToolRecords.make
	const find = Effect.fn("ToolOrigins.find")(function* (key: Key) {
		const execution = yield* store.loadMember(key)
		if (execution.record.resource.kind === "ToolCall")
			return Option.some({
				...(yield* tools.parent(key)),
				toolKey: key,
				path: [] as ReadonlyArray<string>,
			})
		const row = Arr.head(
			yield* db
				.select()
				.from(toolOrigins)
				.where(
					and(
						eq(toolOrigins.namespace, key.namespace),
						eq(toolOrigins.executionId, key.id),
					),
				),
		)
		if (Option.isNone(row)) return Option.none()
		const toolKey = {
			namespace: key.namespace,
			id: Execution.Id.make(row.value.toolExecutionId),
		}
		const origin = yield* tools.parent(toolKey)
		if (!sameIdentity(execution.identity, origin.child.identity))
			return yield* Execution.Forbidden.make({})
		return Option.some({ ...origin, toolKey, path: row.value.path })
	}, storage)

	/** Call inside the command transaction that creates the child execution. */
	const attach = Effect.fn("ToolOrigins.attach")(function* (
		source: Fence,
		child: Key,
		site: Execution.CallSite,
	) {
		if (source.namespace !== child.namespace || source.id === child.id)
			return yield* Execution.Forbidden.make({})
		return yield* store.commit(
			source,
			{},
			Effect.gen(function* () {
				const found = yield* find(source)
				if (
					Option.isNone(found) ||
					site.main !== found.value.child.record.callId ||
					!contains(found.value.path, site.path)
				)
					return yield* Execution.Forbidden.make({})
				const before = yield* store.loadMember(child)
				yield* store.lock({ ...child, generation: before.generation })
				const target = yield* store.loadMember(child)
				if (
					target.record.resource.kind === "Turn" ||
					target.record.resource.kind === "ToolCall" ||
					!sameIdentity(target.identity, found.value.child.identity)
				)
					return yield* Execution.Forbidden.make({})
				const prior = yield* find(child)
				if (Option.isSome(prior)) {
					if (
						prior.value.toolKey.id !== found.value.toolKey.id ||
						!samePath(prior.value.path, site.path)
					)
						return yield* Execution.Conflict.make({ id: child.id })
					return
				}
				if (target.record.status !== "queued")
					return yield* Execution.Conflict.make({ id: child.id })
				yield* db
					.update(executions)
					.set({
						contextKind: "Chat",
						contextId: found.value.child.record.position.chat,
					})
					.where(
						and(
							eq(executions.namespace, child.namespace),
							eq(executions.id, child.id),
						),
					)
				yield* db.insert(toolOrigins).values({
					namespace: child.namespace,
					executionId: child.id,
					toolExecutionId: found.value.toolKey.id,
					path: [...site.path],
				})
			}),
		)
	}, storage)
	return { find, attach }
})
