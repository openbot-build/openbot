import * as Imported from "../database/conversion/Executions.ts"
import * as ImportedHistory from "../apps/ImportedHistory.ts"
import { type Chat } from "@openbot-build/core"
import {
	Authorization,
	type Caller,
	Execution,
	ExperienceNotFound,
	AppCalls as Domain,
} from "@openbot-build/domain"
import { and, asc, eq, or } from "drizzle-orm"
import { Array as Arr, Effect, Option, type Schema } from "effect"
import * as Check from "../authorization/Check.ts"
import * as Db from "../database/Database.ts"
import {
	executions,
	toolOrigins,
	toolExecutions,
} from "../database/ExecutionSchema.ts"
import { transactionFailures } from "../execution/Store.ts"
import { ownerKey } from "../apps/StoredConnections.ts"
import { AppCommands } from "./AppCommands.ts"

/** Lists and single reads use the same saved source Chat and current rights. */
export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const checks = yield* Check.make
	const history = yield* ImportedHistory.make
	const work = yield* AppCommands
	const locate = Effect.fn("AppQueries.locate")(function* (
		caller: Caller,
		id: Domain.AppOperationId,
	) {
		const found = Arr.head(
			yield* db
				.select({
					id: executions.id,
					namespace: executions.namespace,
					workflow: executions.workflow,
				})
				.from(executions)
				.where(
					and(
						eq(executions.namespace, ownerKey(caller)),
						eq(executions.organizationId, caller.organizationId),
						eq(executions.resourceKind, "AppCall"),
						eq(executions.resourceId, id),
					),
				)
				.limit(1),
		)
		if (Option.isNone(found)) return yield* ExperienceNotFound.make({ id })
		const key = {
			namespace: found.value.namespace,
			id: Execution.Id.make(found.value.id),
		}
		const old = found.value.workflow === Imported.workflowName
		if (!old) yield* work.authorize(key, caller, "read")
		return { key, old }
	}, transactionFailures)
	const read = (caller: Caller, id: Domain.AppOperationId) =>
		locate(caller, id).pipe(
			Effect.flatMap(({ key, old }) =>
				old
					? history.app(key, caller).pipe(Effect.map((value) => value.view))
					: work.view(key),
			),
		)
	const list = Effect.fn("AppQueries.list")(function* (
		caller: Caller,
		chat: Chat.Id,
	) {
		yield* checks.check(caller, {
			action: "read",
			resource: Authorization.Chat.make({
				organizationId: caller.organizationId,
				ownerUserId: caller.userId,
				id: chat,
			}),
		})
		const rows = yield* db
			.select({ id: executions.resourceId })
			.from(executions)
			.leftJoin(
				toolOrigins,
				and(
					eq(toolOrigins.namespace, executions.namespace),
					eq(toolOrigins.executionId, executions.id),
				),
			)
			.leftJoin(
				toolExecutions,
				and(
					eq(toolExecutions.namespace, toolOrigins.namespace),
					eq(toolExecutions.executionId, toolOrigins.toolExecutionId),
				),
			)
			.where(
				and(
					eq(executions.namespace, ownerKey(caller)),
					eq(executions.organizationId, caller.organizationId),
					eq(executions.resourceKind, "AppCall"),
					or(
						eq(toolExecutions.chat, chat),
						and(
							eq(executions.workflow, Imported.workflowName),
							eq(executions.contextKind, "Chat"),
							eq(executions.contextId, chat),
						),
					),
				),
			)
			.orderBy(asc(executions.createdAt), asc(executions.id))
		return yield* Effect.forEach(rows, (row) =>
			read(caller, Domain.AppOperationId.make(row.id)),
		)
	}, transactionFailures)
	return {
		read,
		/** A history binding also needs the exact saved tool position. */
		history: (caller: Caller, id: Domain.AppOperationId) =>
			locate(caller, id).pipe(
				Effect.flatMap(({ key, old }) =>
					Effect.gen(function* () {
						if (old) return yield* history.position(key, caller)
						const saved = yield* work.load(key)
						return {
							operation: yield* work.view(key),
							position: saved.origin.child.record.position,
						}
					}),
				),
			),
		list,
		respond: (
			caller: Caller,
			id: Domain.AppOperationId,
			commandKey: Execution.CommandKey,
			round: number,
			responses: Schema.JsonObject,
		) =>
			locate(caller, id).pipe(
				Effect.flatMap(({ key, old }) =>
					old
						? history
								.app(key, caller)
								.pipe(
									Effect.andThen(
										Effect.fail(Execution.Conflict.make({ id: key.id })),
									),
								)
						: work.respond(key, caller, commandKey, round, responses),
				),
			),
	}
})
