import { Channels as Domain, Execution } from "@openbot-build/domain"
import { and, eq } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import * as Db from "../database/Database.ts"
import { channels, executions } from "../database/Schema.ts"
import { storage, transactionFailures } from "../execution/Store.ts"

import { Channels } from "./Channels.ts"

export const removalWorkflow = "openbot.channel-removal"

/** Hold this row lock until the new work and its Channel references commit. */
export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const records = yield* Channels
	return (organizationId: string, id: string, enabled: boolean = true) =>
		Effect.gen(function* () {
			const row = (yield* db
				.select()
				.from(channels)
				.where(
					and(eq(channels.organizationId, organizationId), eq(channels.id, id)),
				)
				.for("update"))[0]
			if (row === undefined) return yield* Domain.ChannelNotFound.make({ id })
			if (row.executionId !== null) {
				const work = (yield* db
					.select({ workflow: executions.workflow, status: executions.status })
					.from(executions)
					.where(eq(executions.id, row.executionId)))[0]
				if (
					work?.workflow === removalWorkflow &&
					!Execution.isTerminal(
						yield* Schema.decodeUnknownEffect(Execution.Status)(
							work.status,
						).pipe(storage),
					)
				)
					return yield* Domain.ChannelConflict.make({ version: row.version })
			}
			if (
				enabled &&
				(!row.enabled ||
					Option.isNone(yield* records.authority(organizationId, id)))
			)
				return yield* Execution.Forbidden.make({})
			return row
		}).pipe(transactionFailures)
})
