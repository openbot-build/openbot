import { Execution } from "@openbot-build/domain"
import { eq } from "drizzle-orm"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import * as Db from "../../src/database/Database.ts"
import { executions } from "../../src/database/Schema.ts"
import { Store as ExecutionStore } from "../../src/execution/Store.ts"

/** Reads the saved people and Channel of work that came from a Turn. */
export const turnAuthority = (turnId: string) =>
	Effect.gen(function* () {
		const db = yield* Db.make
		const store = yield* ExecutionStore
		const rows = yield* db
			.select({ namespace: executions.namespace, id: executions.id })
			.from(executions)
			.where(eq(executions.resourceId, turnId))
		return yield* Effect.forEach(rows, (row) =>
			store
				.loadMember({ namespace: row.namespace, id: Execution.Id.make(row.id) })
				.pipe(
					Effect.map((saved) => ({
						actor: saved.identity.actor,
						owner: saved.identity.owner,
						channel: saved.identity.channel,
					})),
				),
		)
	})

/** Waits for saved Channel work to reach an end before a host restart. */
export const channelWorkSettled = (organizationId: string) =>
	Effect.gen(function* () {
		const db = yield* Db.make
		const rows = yield* db
			.select({ workflow: executions.workflow, status: executions.status })
			.from(executions)
			.where(eq(executions.organizationId, organizationId))
		return Arr.every(
			rows,
			(row) =>
				!Str.startsWith("openbot.channel-")(row.workflow) ||
				row.status === "completed" ||
				row.status === "failed" ||
				row.status === "cancelled" ||
				row.status === "interrupted",
		)
			? Option.some(undefined)
			: Option.none()
	})

/** Reads only the saved call states for a Channel setup. */
export const registrationCallStatuses = (
	executionId: string,
	organizationId: string,
) =>
	Effect.gen(function* () {
		const store = yield* ExecutionStore
		const key = yield* store.locate(
			Execution.Id.make(executionId),
			organizationId,
		)
		return Arr.map(yield* store.calls(key), (call) => call.status)
	})
