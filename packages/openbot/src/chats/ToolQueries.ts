import { Chat, Turn } from "@openbot-build/core"
import { type Caller, Execution, ToolExecution } from "@openbot-build/domain"
import { and, eq } from "drizzle-orm"
import { Array as Arr, Effect, Option, Order, Schema } from "effect"
import { ownerKey } from "../apps/StoredConnections.ts"
import * as Db from "../database/Database.ts"
import * as Imported from "../database/conversion/Executions.ts"
import * as ImportedWorkflow from "../database/conversion/ImportedWorkflow.ts"
import * as Legacy from "../database/conversion/LegacyChats.ts"
import { executions, toolExecutions } from "../database/ExecutionSchema.ts"
import { Store, transactionFailures } from "../execution/Store.ts"
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
	const imported = yield* ImportedWorkflow.make
	const historyRows = (
		namespace: string,
		chat: Chat.Id,
		id?: ToolExecution.Id,
	) =>
		db
			.select({ id: executions.id })
			.from(executions)
			.where(
				and(
					eq(executions.namespace, namespace),
					eq(executions.workflow, Imported.workflowName),
					eq(executions.resourceKind, "ToolCall"),
					eq(executions.contextKind, "Chat"),
					eq(executions.contextId, chat),
					id === undefined ? undefined : eq(executions.resourceId, id),
				),
			)
			.orderBy(executions.createdAt, executions.id)
	const history = Effect.fn("ToolQueries.history")(function* (
		caller: Caller,
		chat: Chat.Id,
		executionId: string,
	) {
		const namespace = ownerKey(caller)
		const key = { namespace, id: Execution.Id.make(executionId) }
		const { saved, input } = yield* imported.read(key, caller)
		const old = yield* Schema.decodeUnknownEffect(Legacy.Operation)(
			input.history,
		)
		if (
			saved.record.resource.kind !== "ToolCall" ||
			saved.record.resource.id !== old.id ||
			old.chat !== chat ||
			saved.context?.kind !== "Chat" ||
			saved.context.id !== chat
		)
			return yield* Execution.Conflict.make({ id: key.id })
		const parents = yield* db
			.select({ id: executions.id })
			.from(executions)
			.where(
				and(
					eq(executions.namespace, namespace),
					eq(executions.resourceKind, "Turn"),
					eq(executions.resourceId, old.turn),
					eq(executions.contextKind, "Chat"),
					eq(executions.contextId, chat),
				),
			)
			.limit(2)
		if (parents.length !== 1 || parents[0] === undefined)
			return yield* Execution.Conflict.make({ id: key.id })
		return {
			_tag: "Imported" as const,
			id: ToolExecution.Id.make(old.id),
			executionId: key.id,
			parentExecutionId: Execution.Id.make(parents[0].id),
			chat,
			turn: Turn.Id.make(old.turn),
			callId: old.callId,
			tool: old.tool,
			kind: old.kind,
			status: saved.record.status,
			startedAt: old.startedAt,
			endedAt:
				old.endedAt ??
				(Execution.isTerminal(saved.record.status)
					? saved.record.updatedAt
					: null),
			failure: saved.record.failure,
			output: old.status._tag === "Completed" ? old.status.result : null,
		}
	}, transactionFailures)
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
		const old = yield* Effect.forEach(
			yield* historyRows(namespace, chat),
			(row) =>
				history(caller, chat, row.id).pipe(
					Effect.map(({ output: _output, ...record }) => record),
				),
		)
		return Arr.sort(
			[...rows, ...old],
			Order.mapInput(
				Order.Number,
				(row: ToolExecution.Summary) => row.startedAt,
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
		if (Option.isNone(found)) {
			const old = yield* historyRows(namespace, chat, id)
			if (old.length === 0) return yield* ToolExecution.NotFound.make({ id })
			if (old.length !== 1 || old[0] === undefined)
				return yield* Execution.Conflict.make({ id: Execution.Id.make(id) })
			return yield* history(caller, chat, old[0].id)
		}
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
