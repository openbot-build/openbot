import type { Caller } from "@openbot-build/domain/Identity"
import { Chat } from "@openbot-build/core"
import { Execution, ToolExecution } from "@openbot-build/domain"
import { and, eq } from "drizzle-orm"
import { Array as Arr, Effect, Option, Order, Schema } from "effect"
import { ownerKey } from "@openbot-build/apps-contract/apps/StoredConnections"
import * as Db from "@openbot-build/server-database/Database"
import { toolExecutions } from "@openbot-build/server-database/ExecutionSchema"
import {
	Store,
	transactionFailures,
} from "@openbot-build/server-execution/Store"
import * as ChatQueries from "./ChatQueries.ts"
import { ToolCommands } from "./ToolCommands.ts"
import * as ToolResults from "./ToolResults.ts"
import { outputCodec } from "./ToolSteps.ts"

/** Query rights apply to the Chat and to each saved tool source. */
export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const chats = yield* ChatQueries.make
	const tools = yield* ToolCommands
	const store = yield* Store
	const list = Effect.fn("ToolQueries.list")(function* (
		caller: Caller,
		chat: Chat.Id,
	) {
		yield* chats.read(caller, chat)
		const namespace = ownerKey(caller)
		const rows = yield* tools.list(namespace, chat)
		yield* Effect.forEach(rows, (row) =>
			tools.authorize({ namespace, id: row.executionId }, caller, "read"),
		)
		return Arr.sort(
			rows,
			Order.mapInput(
				Order.Number,
				(row: ToolExecution.Record) => row.startedAt,
			),
		)
	}, transactionFailures)
	const read = Effect.fn("ToolQueries.read")(function* (
		caller: Caller,
		chat: Chat.Id,
		id: ToolExecution.Id,
	) {
		yield* chats.read(caller, chat)
		const namespace = ownerKey(caller)
		const found = Arr.head(
			yield* db
				.select({ executionId: toolExecutions.executionId })
				.from(toolExecutions)
				.where(
					and(
						eq(toolExecutions.namespace, namespace),
						eq(toolExecutions.chat, chat),
						eq(toolExecutions.id, id),
					),
				),
		)
		if (Option.isNone(found)) return yield* ToolExecution.NotFound.make({ id })
		const key = { namespace, id: Execution.Id.make(found.value.executionId) }
		yield* tools.authorize(key, caller, "read")
		const saved = yield* tools.load(key)
		return {
			...saved.record,
			output: Execution.isTerminal(saved.record.status)
				? yield* ToolResults.output(
						{
							...saved.record,
							detached: false,
							calls: yield* store.calls(key),
						},
						saved.input.call,
					).pipe(Effect.flatMap(Schema.encodeEffect(outputCodec)))
				: null,
		}
	}, transactionFailures)
	return { list, read }
})
