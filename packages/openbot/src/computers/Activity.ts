import { Computers, Execution } from "@openbot-build/domain"
import { and, eq, inArray, isNull, notInArray, or } from "drizzle-orm"
import { Array as Arr, Clock, Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import * as Db from "../database/Database.ts"
import {
	chats,
	computerAccess,
	computers,
	executions,
} from "../database/Schema.ts"
import { transactionFailures } from "../execution/Store.ts"

export const workflowName = "openbot.computer-lifecycle"
export const pauseWorkflowName = "openbot.computer-idle-pause"
export const terminal = ["completed", "failed", "cancelled", "interrupted"]
export const where = (organizationId: string, id: string) =>
	and(eq(computers.organizationId, organizationId), eq(computers.id, id))

/** Work and idle admission share the Computer row lock. No outside call holds it. */
export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const row = (organizationId: string, id: string, lock = false) => {
		const query = db.select().from(computers).where(where(organizationId, id))
		return (lock ? query.for("update") : query).pipe(Effect.map(Arr.head))
	}
	const active = (organizationId: string, id: string) =>
		db
			.select({ id: executions.id })
			.from(executions)
			.where(
				and(
					eq(executions.namespace, organizationId),
					inArray(executions.workflow, [workflowName, pauseWorkflowName]),
					eq(executions.resourceKind, "Computer"),
					eq(executions.resourceId, id),
					notInArray(executions.status, terminal),
				),
			)
			.limit(1)
			.pipe(Effect.map(Arr.head))
	/** Saved work can need the Computer after a long model call, before the next tool call. */
	const work = (organizationId: string, id: string) =>
		db
			.select({ id: executions.id })
			.from(executions)
			.innerJoin(
				chats,
				and(
					eq(chats.namespace, executions.namespace),
					or(
						and(
							eq(executions.contextKind, "Chat"),
							eq(executions.contextId, chats.id),
						),
						and(
							eq(executions.resourceKind, "Chat"),
							eq(executions.resourceId, chats.id),
						),
						and(
							eq(executions.resourceKind, "Turn"),
							eq(executions.resourceId, chats.turn),
						),
					),
				),
			)
			.innerJoin(
				computerAccess,
				and(
					eq(computerAccess.organizationId, executions.organizationId),
					eq(computerAccess.bot, chats.bot),
				),
			)
			.innerJoin(
				computers,
				and(
					eq(computers.organizationId, computerAccess.organizationId),
					eq(computers.id, computerAccess.computerId),
				),
			)
			.where(
				and(
					where(organizationId, id),
					or(
						isNull(computers.ownerUserId),
						eq(computers.ownerUserId, executions.userId),
					),
					notInArray(executions.status, terminal),
					// A future reminder can wait for days without using this Computer.
					notInArray(executions.resourceKind, ["Reminder"]),
				),
			)
			.limit(1)
			.pipe(Effect.map((rows) => rows.length > 0))
	const ready = (organizationId: string, id: string) =>
		Effect.gen(function* () {
			const found = yield* row(organizationId, id, true)
			if (Option.isNone(found))
				return yield* Computers.ComputerNotFound.make({ id })
			const pending = yield* active(organizationId, id)
			if (Option.isSome(pending))
				return yield* Computers.ComputerConflict.make({
					version: found.value.version,
					executionId: Execution.Id.make(pending.value.id),
				})
			return found.value
		})
	const mark = (organizationId: string, id: string) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					yield* ready(organizationId, id)
					yield* db
						.update(computers)
						.set({ lastActiveAt: yield* Clock.currentTimeMillis })
						.where(where(organizationId, id))
				}),
			)
			.pipe(transactionFailures)
	return { row, active, work, ready, mark }
})
