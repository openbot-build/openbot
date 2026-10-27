import { Caller, ConnectionId, Execution } from "@openbot-build/domain"
import { Array as Arr, Context, Effect, Layer, Schema } from "effect"
import { and, asc, eq, inArray } from "drizzle-orm"
import * as Db from "../database/Database.ts"
import { appConnections, appDrafts, appSecrets } from "../database/Schema.ts"
import type { Authorize } from "../execution/Engine.ts"
import { Store, storage, type Key } from "../execution/Store.ts"
import { AuthorizationCommands } from "./AuthorizationCommands.ts"
import * as Check from "../authorization/Check.ts"
import { ownerKey } from "./StoredConnections.ts"

export const workflowName = "openbot.app-reset"
const Input = Schema.Struct({ connections: Schema.Array(ConnectionId) })
const sameCaller = Schema.toEquivalence(Caller)
const make = Effect.gen(function* () {
	const store = yield* Store
	const authorization = yield* AuthorizationCommands
	const checks = yield* Check.make
	const db = yield* Db.make
	const check = (actor: Caller, action: "read" | "write") =>
		checks
			.check(actor, {
				action,
				kind: "Connection",
				within: ($) =>
					$.under("org", actor.organizationId, "user", actor.userId),
			})
			.pipe(
				Effect.catchTags({
					Forbidden: () => Effect.fail(Execution.Forbidden.make({})),
					Pending: () => Effect.fail(Execution.Forbidden.make({})),
					PolicyUnavailable: (cause) =>
						Effect.fail(Execution.StorageError.make({ cause })),
				}),
			)
	const load = (key: Key) =>
		Effect.gen(function* () {
			const saved = yield* store.loadMember(key)
			const input = yield* Schema.decodeUnknownEffect(Input)(saved.input).pipe(
				Effect.orDie,
			)
			if (
				saved.workflow !== workflowName ||
				key.namespace !== ownerKey(saved.identity.owner) ||
				saved.record.resource.kind !== "AppReset"
			)
				return yield* Execution.Forbidden.make({})
			return { saved, input }
		})
	const authorize: Authorize = (key, actor, mode) =>
		Effect.gen(function* () {
			const { saved, input } = yield* load(key)
			if (
				ownerKey(actor) !== key.namespace ||
				((mode === "advance" || mode === "replay") &&
					!sameCaller(actor, saved.identity.actor))
			)
				return yield* Execution.Forbidden.make({})
			yield* check(actor, mode === "read" ? "read" : "write")
			for (const id of input.connections)
				yield* authorization.check(
					actor,
					id,
					mode === "read" ? "read" : "write",
				)
		})
	const start = (actor: Caller, commandKey: Execution.CommandKey) =>
		Effect.gen(function* () {
			const namespace = ownerKey(actor)
			yield* check(actor, "write")
			const receipt = yield* store.accept(
				namespace,
				commandKey,
				{ actor, body: { kind: "reset-apps" } },
				(create) =>
					Effect.gen(function* () {
						yield* check(actor, "write")
						const rows = yield* storage(
							db
								.select({ id: appConnections.id })
								.from(appConnections)
								.where(eq(appConnections.owner, namespace))
								.orderBy(asc(appConnections.id)),
						)
						const ids = yield* Schema.decodeEffect(Schema.Array(ConnectionId))(
							Arr.map(rows, (row) => row.id),
						)
						for (const id of ids) yield* authorization.check(actor, id)
						const key = yield* create({
							workflow: workflowName,
							identity: {
								owner: {
									organizationId: actor.organizationId,
									userId: actor.userId,
								},
								actor,
							},
							resource: { kind: "AppReset", id: namespace },
							input: { connections: ids },
						})
						// The request fixes its set of connections. Later additions are not part of this reset.
						yield* storage(
							db.delete(appDrafts).where(eq(appDrafts.owner, namespace)),
						)
						yield* storage(
							db
								.delete(appSecrets)
								.where(
									and(
										eq(appSecrets.owner, namespace),
										inArray(appSecrets.kind, [
											"app-view",
											"app-ui-state",
											"app-view-action",
										]),
									),
								),
						)
						return { executionId: key.id, start: true }
					}),
			)
			yield* authorize({ namespace, id: receipt.executionId }, actor, "advance")
			return receipt
		})
	const get = (actor: Caller, id: Execution.Id) =>
		Effect.gen(function* () {
			const key = { namespace: ownerKey(actor), id }
			yield* authorize(key, actor, "read")
			return {
				execution: yield* store.get(key),
				connections: Arr.map(yield* store.owned(key), (child) => ({
					connectionId: ConnectionId.make(child.record.resource.id),
					execution: child.record,
				})),
			}
		})
	return { start, get, load, authorize }
})
export class ResetCommands extends Context.Service<
	ResetCommands,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/apps/ResetCommands") {}
export const layer = Layer.effect(ResetCommands, make)
