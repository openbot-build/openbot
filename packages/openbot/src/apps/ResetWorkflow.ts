import { Execution } from "@openbot-build/domain"
import { Array as Arr, Effect, Layer } from "effect"
import { eq, and } from "drizzle-orm"
import * as Db from "../database/Database.ts"
import { appConnections } from "../database/Schema.ts"
import * as Children from "../execution/Children.ts"
import * as Engine from "../execution/Engine.ts"
import * as Program from "../execution/Program.ts"
import { Store, storage, type Fence } from "../execution/Store.ts"
import {
	AuthorizationCommands,
	workflowName as childWorkflow,
} from "./AuthorizationCommands.ts"
import { ResetCommands, workflowName } from "./ResetCommands.ts"
export const workflow = Engine.define(workflowName)
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const commands = yield* ResetCommands
		const authorization = yield* AuthorizationCommands
		const store = yield* Store
		const db = yield* Db.make
		const children = yield* Children.make
		const run = yield* Program.make
		const registry = yield* Engine.Registry
		const work = (fence: Fence) =>
			Effect.gen(function* () {
				const { saved, input } = yield* commands.load(fence)
				yield* commands.authorize(fence, saved.identity.actor, "advance")
				for (const id of input.connections) {
					// A separate removal may already have ended before this reset starts.
					const rows = yield* storage(
						db
							.select({ id: appConnections.id })
							.from(appConnections)
							.where(
								and(
									eq(appConnections.owner, fence.namespace),
									eq(appConnections.id, id),
								),
							),
					)
					if (rows.length === 0) continue
					yield* authorization.start(
						saved.identity.actor,
						{ kind: "Remove", connectionId: id },
						Execution.CommandKey.make(`reset:${fence.id}:${id}`),
						fence,
					)
				}
				const linked = yield* children.list(fence, [childWorkflow])
				const owned = yield* store.owned(fence)
				const missing = Arr.filter(
					owned,
					(child) => !Arr.some(linked, (key) => key.id === child.key.id),
				)
				if (missing.length > 0)
					yield* store.commit(
						fence,
						{
							events: Arr.map(missing, (child) => ({
								_tag: "ChildExecution",
								executionId: child.key.id,
								step: `remove:${child.record.resource.id}`,
							})),
						},
						Effect.void,
					)
				yield* children.waitOwned(fence)
				yield* commands.authorize(fence, saved.identity.actor, "advance")
				for (const child of yield* store.owned(fence)) {
					if (child.record.status === "completed") continue
					if (child.record.failure !== null)
						return yield* Effect.fail(child.record.failure)
					return yield* Execution.Conflict.make({ id: child.key.id })
				}
				yield* store.commit(
					fence,
					{
						status: "completed",
						events: [{ _tag: "Result", resource: saved.record.resource }],
					},
					Effect.void,
				)
			})
		const finish = (fence: Fence, end: Program.End) =>
			Effect.gen(function* () {
				yield* children.stopOwned(fence)
				if (end.status === "cancelled")
					yield* store.finishCancellation(fence, end.epoch, () =>
						Effect.succeed([]),
					)
				else
					yield* store.commit(
						fence,
						{
							status: end.status,
							...(end.status === "failed" ? { failure: end.failure } : {}),
						},
						Effect.void,
					)
			})
		return workflow
			.toLayer((key) => run(key, work, finish))
			.pipe(
				Layer.provideMerge(
					Layer.effectDiscard(registry.register(workflow, commands.authorize)),
				),
			)
	}),
)
