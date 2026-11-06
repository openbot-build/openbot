import type { Caller } from "@openbot-build/domain/Identity"
import { ExperienceNotFound } from "@openbot-build/domain/ExperienceErrors"
import { type Chat } from "@openbot-build/core"
import {
	Authorization,
	Execution,
	AppCalls as Domain,
} from "@openbot-build/domain"
import { and, asc, eq } from "drizzle-orm"
import { Array as Arr, Effect, Option, type Schema } from "effect"
import * as Check from "@openbot-build/identity-contract/authorization/Check"
import * as Db from "@openbot-build/server-database/Database"
import {
	executions,
	toolOrigins,
	toolExecutions,
} from "@openbot-build/server-database/ExecutionSchema"
import { transactionFailures } from "@openbot-build/server-execution/Store"
import { ownerKey } from "./StoredConnections.ts"
import { AppCommands } from "./AppCommands.ts"

/** Lists and single reads use the same saved source Chat and current rights. */
export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const checks = yield* Check.make
	const work = yield* AppCommands
	const locate = Effect.fn("AppQueries.locate")(function* (
		caller: Caller,
		id: Domain.AppOperationId,
	) {
		const found = Arr.head(
			yield* db
				.select({ id: executions.id, namespace: executions.namespace })
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
		yield* work.authorize(key, caller, "read")
		return key
	}, transactionFailures)
	const read = (caller: Caller, id: Domain.AppOperationId) =>
		locate(caller, id).pipe(Effect.flatMap(work.view))
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
					eq(toolExecutions.chat, chat),
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
				Effect.flatMap((key) =>
					Effect.gen(function* () {
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
				Effect.flatMap((key) =>
					work.respond(key, caller, commandKey, round, responses),
				),
			),
	}
})
