import { Definition } from "./ToolDefinitions.ts"
import { Chat, Turn } from "@openbot-build/core"
import {
	Execution,
	ExecutionIdentity,
	ToolExecution,
} from "@openbot-build/domain"
import { and, eq } from "drizzle-orm"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { Prompt } from "effect/ai"
import * as Db from "../database/Database.ts"
import { toolExecutions } from "../database/ExecutionSchema.ts"
import { Store, storage, type Key } from "../execution/Store.ts"
import * as ChatHost from "./ChatHost.ts"

export const workflowName = "openbot.tool-call"
export const Request = Schema.Struct({
	position: ToolExecution.Position,
	call: Prompt.ToolCallPart,
	definition: Schema.optionalKey(Definition),
	/** Null means that this call must stay in its Turn. */
	budgetMs: Schema.NullOr(
		Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	),
	maxDurationMs: Schema.Finite.check(Schema.isGreaterThan(0)),
	limit: Schema.Natural,
})
export const Input = Schema.Struct({
	...Request.fields,
	context: Schema.Struct({
		host: ChatHost.ChatHostState,
		settings: Turn.Settings,
		prompt: Turn.PendingStep.fields.input,
		action: Schema.optionalKey(Turn.Action),
	}),
})
export type Input = typeof Input.Type
export const codec = Schema.toCodecJson(Input)

/** Shared reads of a tool's saved input and execution. This does not own its life. */
export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const store = yield* Store
	const row = Effect.fn("ToolRecords.row")(function* (key: Key) {
		const found = Arr.head(
			yield* db
				.select()
				.from(toolExecutions)
				.where(
					and(
						eq(toolExecutions.namespace, key.namespace),
						eq(toolExecutions.executionId, key.id),
					),
				),
		)
		if (Option.isNone(found))
			return yield* Execution.NotFound.make({ id: key.id })
		return found.value
	})
	const load = Effect.fn("ToolRecords.load")(function* (key: Key) {
		const saved = yield* row(key)
		const execution = yield* store.loadMember(key)
		const input = yield* Schema.decodeEffect(codec)(execution.input)
		if (
			execution.workflow !== workflowName ||
			execution.record.resource.kind !== "ToolCall" ||
			execution.record.resource.id !== saved.id ||
			input.position.chat !== saved.chat ||
			input.position.turn !== saved.turn ||
			input.position.item !== saved.item ||
			input.call.id !== saved.callId
		)
			return yield* Execution.Conflict.make({ id: key.id })
		const record = yield* Schema.decodeEffect(ToolExecution.Record)({
			id: saved.id,
			executionId: key.id,
			parentExecutionId: saved.parentExecutionId,
			position: input.position,
			callId: input.call.id,
			tool: input.call.name,
			status: execution.record.status,
			detached: saved.detached,
			startedAt: execution.record.createdAt,
			deadline: execution.record.createdAt + input.maxDurationMs,
			failure: execution.record.failure,
		})
		return { record, input, identity: execution.identity }
	}, storage)

	/** A tool keeps the identity and position of the Turn that submitted it. */
	const parent = Effect.fn("ToolRecords.parent")(
		function* (key: Key) {
			const child = yield* load(key)
			const parentKey = {
				namespace: key.namespace,
				id: child.record.parentExecutionId,
			}
			const execution = yield* store.loadMember(parentKey)
			const reference = yield* Schema.decodeUnknownEffect(
				Schema.Struct({ chat: Chat.Id }),
			)(execution.input)
			if (
				execution.record.resource.kind !== "Turn" ||
				execution.record.resource.id !== child.record.position.turn ||
				reference.chat !== child.record.position.chat ||
				!Schema.toEquivalence(ExecutionIdentity)(
					execution.identity,
					child.identity,
				)
			)
				return yield* Execution.Forbidden.make({})
			return { key: parentKey, execution, child }
		},
		(effect) =>
			effect.pipe(
				Effect.mapError((error) =>
					Schema.is(Execution.Conflict)(error)
						? Execution.StorageError.make({ cause: error })
						: error,
				),
				storage,
			),
	)
	return { row, load, parent }
})
