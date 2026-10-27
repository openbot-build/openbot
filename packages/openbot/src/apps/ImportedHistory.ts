import { Item } from "@openbot-build/core"
import {
	AppCalls,
	type Caller,
	CodeRuns,
	Execution,
} from "@openbot-build/domain"
import { and, asc, eq } from "drizzle-orm"
import { Array as Arr, Effect, Option, Schema } from "effect"
import * as Db from "../database/Database.ts"
import { executions } from "../database/ExecutionSchema.ts"
import { chatItems } from "../database/Schema.ts"
import { AppHistory, CodeHistory } from "../database/conversion/AppHistory.ts"
import * as Imported from "../database/conversion/Executions.ts"
import * as ImportedWorkflow from "../database/conversion/ImportedWorkflow.ts"
import { storage, type Key } from "../execution/Store.ts"
import { ownerKey } from "./StoredConnections.ts"

/** Old history is read through the same current policy as its execution log. */
export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const imported = yield* ImportedWorkflow.make
	const app = Effect.fn("ImportedAppHistory.read")(function* (
		key: Key,
		caller: Caller,
	) {
		const { saved, input } = yield* imported.read(key, caller)
		const { invocation } = yield* Schema.decodeUnknownEffect(AppHistory)(
			input.history,
		)
		if (
			saved.record.resource.kind !== "AppCall" ||
			saved.record.resource.id !== invocation.id ||
			saved.context?.kind !== "Chat" ||
			saved.context.id !== invocation.chat
		)
			return yield* Execution.Forbidden.make({})
		const result = invocation.result
		const outcome =
			result?._tag === "Completed"
				? { _tag: "Completed" as const, result: result.result }
				: result?._tag === "InputRequired"
					? { _tag: "InputRequired" as const, request: result.request }
					: result?._tag === "Failed" && saved.record.failure !== null
						? { _tag: "Failed" as const, failure: saved.record.failure }
						: null
		const view = yield* Schema.decodeUnknownEffect(AppCalls.ExecutionView)({
			...invocation,
			executionId: key.id,
			status: saved.record.status,
			result: outcome,
			failure: saved.record.failure,
			createdAt: saved.record.createdAt,
			updatedAt: saved.record.updatedAt,
		})
		return { view, invocation }
	}, storage)
	const position = Effect.fn("ImportedAppHistory.position")(function* (
		key: Key,
		caller: Caller,
	) {
		const { view } = yield* app(key, caller)
		const rows = yield* db
			.select({ value: chatItems.value })
			.from(chatItems)
			.where(
				and(
					eq(chatItems.namespace, key.namespace),
					eq(chatItems.chat, view.chat),
					eq(chatItems.turn, view.turn),
				),
			)
			.orderBy(asc(chatItems.seq))
		const matching = Arr.filter(
			yield* Effect.forEach(rows, (row) =>
				Schema.decodeEffect(Schema.fromJsonString(Item.Record))(row.value),
			),
			(item) =>
				item.origin !== undefined &&
				item.origin.chat === view.chat &&
				item.origin.turn === view.turn &&
				Arr.some(
					item.content.content,
					(message) =>
						message.role === "tool" &&
						Arr.some(
							message.content,
							(part) => part.type === "tool-result" && part.id === view.callId,
						),
				),
		)
		const found = matching[0]?.origin
		if (matching.length !== 1 || found === undefined)
			return yield* Execution.Conflict.make({ id: key.id })
		return { operation: view, position: found }
	}, storage)
	const code = Effect.fn("ImportedCodeHistory.read")(function* (
		key: Key,
		caller: Caller,
	) {
		const { saved, input } = yield* imported.read(key, caller)
		const { run } = yield* Schema.decodeUnknownEffect(CodeHistory)(
			input.history,
		)
		if (
			saved.record.resource.kind !== "CodeRun" ||
			saved.record.resource.id !== run.id ||
			saved.context?.kind !== "Chat" ||
			saved.context.id !== run.chat
		)
			return yield* Execution.Forbidden.make({})
		const calls = yield* Effect.forEach(run.calls, (call) =>
			Effect.gen(function* () {
				if (call.operationId === undefined)
					return {
						index: call.index,
						binding: call.binding,
						app: null,
						rejection:
							call.outcome._tag === "Denied"
								? { name: "Denied", message: call.outcome.reason }
								: null,
					}
				const found = Arr.head(
					yield* db
						.select({ id: executions.id, namespace: executions.namespace })
						.from(executions)
						.where(
							and(
								eq(executions.namespace, ownerKey(caller)),
								eq(executions.organizationId, caller.organizationId),
								eq(executions.workflow, Imported.workflowName),
								eq(executions.resourceKind, "AppCall"),
								eq(executions.resourceId, call.operationId),
							),
						),
				)
				if (Option.isNone(found))
					return yield* Execution.Conflict.make({ id: key.id })
				const linked = yield* app(
					{
						namespace: found.value.namespace,
						id: Execution.Id.make(found.value.id),
					},
					caller,
				)
				if (linked.view.chat !== run.chat || linked.view.turn !== run.turn)
					return yield* Execution.Conflict.make({ id: key.id })
				return {
					index: call.index,
					binding: call.binding,
					app: linked.view,
					rejection: null,
				}
			}),
		)
		const result =
			run.result?._tag === "Completed"
				? run.result
				: run.result?._tag === "Failed" && saved.record.failure !== null
					? {
							_tag: "Failed" as const,
							reason: run.result.reason,
							logs: run.result.logs,
							failure: saved.record.failure,
						}
					: null
		return yield* Schema.decodeEffect(CodeRuns.ExecutionView)({
			...run,
			executionId: key.id,
			status: saved.record.status,
			failure: saved.record.failure,
			result,
			calls,
		})
	}, storage)
	return { app, code, position }
})
