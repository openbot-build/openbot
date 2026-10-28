import {
	type MemberExecution,
	Store,
	storage,
	type Fence,
	type Key,
} from "../../execution/Store.ts"
import * as Hex from "effect/encoding/Hex"
import {
	Execution,
	ExecutionIdentity,
	ToolExecution,
} from "@openbot-build/domain"
import {
	Array as Arr,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Schema,
} from "effect"
import { Prompt } from "effect/ai"
import { SqlClient } from "effect/sql"
import { type Authorize } from "../../execution/Engine.ts"
import { TurnAccess } from "../../chats/TurnAccess.ts"
import { Chat, ToolStep, Turn } from "@openbot-build/core"
import * as StoredChats from "../../chats/StoredChats.ts"
import * as Db from "../../database/Database.ts"
import { InputCommands } from "../../chats/InputCommands.ts"
import { Reminders } from "./Reminders.ts"

export const workflowName = "openbot.reminder"
const Input = Schema.Struct({
	parentExecutionId: Execution.Id,
	position: ToolExecution.Position,
	callId: Schema.String,
})
const sameIdentity = Schema.toEquivalence(ExecutionIdentity)
export interface Service {
	readonly load: (key: Key) => Effect.Effect<
		{
			execution: MemberExecution
			record: {
				readonly id: string
				readonly executionId?: Execution.Id
				readonly userId: string
				readonly author: string
				readonly chat: Chat.Id
				readonly turn: Turn.Id
				readonly toolCallId: string
				readonly note: string
				readonly createdAt: number
				readonly dueAt: number
				readonly status: "cancelled" | "done" | "waiting"
			}
			input: typeof Input.Type
		},
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly authorize: Authorize
	readonly start: (
		parent: Fence,
		callId: string,
		note: string,
		dueAt: number,
	) => Effect.Effect<
		{
			readonly id: string
			readonly executionId?: Execution.Id
			readonly userId: string
			readonly author: string
			readonly chat: Chat.Id
			readonly turn: Turn.Id
			readonly toolCallId: string
			readonly note: string
			readonly createdAt: number
			readonly dueAt: number
			readonly status: "cancelled" | "done" | "waiting"
		},
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly deliver: (
		fence: Fence,
	) => Effect.Effect<
		void,
		| Execution.Conflict
		| Execution.KeyConflict
		| (Execution.Forbidden | Execution.NotFound | Execution.StorageError)
	>
	readonly finish: (
		fence: Fence,
		end:
			| { readonly status: "failed"; readonly failure: Execution.Failure }
			| { readonly status: "cancelled"; readonly epoch: number },
	) => Effect.Effect<
		void,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
	>
}

export class ReminderCommands extends Context.Service<
	ReminderCommands,
	Service
>()("@openbot-build/openbot/plugins/work/ReminderCommands") {}

const make = Effect.gen(function* () {
	const store = yield* Store
	const db = yield* Db.make
	const crypto = yield* Crypto.Crypto
	const access = yield* TurnAccess
	const reminders = yield* Reminders
	const inputs = yield* InputCommands
	const sql = yield* SqlClient.SqlClient
	const load = Effect.fn("ReminderCommands.load")(function* (key: Key) {
		const execution = yield* store.loadMember(key)
		const input = yield* Schema.decodeUnknownEffect(Input)(execution.input)
		const parent = yield* store.loadMember({
			namespace: key.namespace,
			id: input.parentExecutionId,
		})
		const source = yield* Schema.decodeUnknownEffect(
			Schema.Struct({ chat: Chat.Id }),
		)(parent.input)
		const record = yield* reminders.find(
			execution.identity.owner.organizationId,
			execution.record.resource.id,
		)
		if (
			execution.workflow !== workflowName ||
			execution.record.resource.kind !== "Reminder" ||
			parent.record.resource.kind !== "Turn" ||
			parent.record.resource.id !== input.position.turn ||
			source.chat !== input.position.chat ||
			Option.isNone(record) ||
			record.value.executionId !== key.id ||
			record.value.chat !== input.position.chat ||
			record.value.turn !== input.position.turn ||
			record.value.toolCallId !== input.callId ||
			!sameIdentity(execution.identity, parent.identity)
		)
			return yield* Execution.Forbidden.make({})
		return { execution, record: record.value, input }
	}, storage)
	const authorize: Authorize = (key, actor, mode) =>
		load(key).pipe(
			Effect.flatMap(({ input }) =>
				access.authorize(
					{ namespace: key.namespace, id: input.parentExecutionId },
					actor,
					mode === "advance" ? "replay" : mode,
				),
			),
		)
	const start = Effect.fn("ReminderCommands.start")(function* (
		parent: Fence,
		callId: string,
		note: string,
		dueAt: number,
	) {
		const source = yield* store.loadMember(parent)
		const input = yield* Schema.decodeUnknownEffect(
			Schema.Struct({ chat: Chat.Id }),
		)(source.input)
		if (source.record.resource.kind !== "Turn")
			return yield* Execution.Forbidden.make({})
		yield* access.authorize(parent, source.identity.actor, "advance")
		const found = yield* StoredChats.ref(db, parent.namespace, input.chat)
		const turn = Option.isSome(found) ? found.value.turn : undefined
		const step = turn?.pendingStep
		if (
			turn?.id !== source.record.resource.id ||
			step === undefined ||
			!Arr.some(
				ToolStep.pending(Turn.stepPrompt(step)),
				(call) => call.id === callId && call.name === "openbot_remind",
			)
		)
			return yield* Execution.Conflict.make({ id: parent.id })
		const position = {
			chat: input.chat,
			turn: turn.id,
			item: step.item,
			step: step.step,
		}
		const name = yield* Schema.encodeEffect(
			Schema.fromJsonString(Schema.Array(Schema.String)),
		)([parent.id, step.item, callId])
		const hash = Hex.encode(
			yield* crypto.digest("SHA-256", new TextEncoder().encode(name)),
		)
		const id = "rem_" + hash
		const receipt = yield* store.accept(
			parent.namespace,
			Execution.CommandKey.make("reminder:" + hash),
			{
				actor: source.identity.actor,
				body: { parentExecutionId: parent.id, position, callId, note },
			},
			(create) =>
				store.commit(
					parent,
					{
						events: (child) => [
							{
								_tag: "ChildExecution",
								executionId: child.executionId,
								step: "reminder",
							},
						],
					},
					Effect.gen(function* () {
						const child = yield* create({
							workflow: workflowName,
							context: { kind: "Chat", id: position.chat },
							...(yield* store.ownership(parent)),
							resource: { kind: "Reminder", id },
							identity: source.identity,
							input: { parentExecutionId: parent.id, position, callId },
						})
						yield* reminders.start(source.identity.owner.organizationId, {
							id,
							executionId: child.id,
							userId: source.identity.owner.userId,
							author: source.identity.actor.userId,
							chat: position.chat,
							turn: position.turn,
							toolCallId: callId,
							note,
							dueAt,
						})
						return { executionId: child.id, start: true }
					}),
				),
		)
		return (yield* load({
			namespace: parent.namespace,
			id: receipt.executionId,
		})).record
	}, storage)

	const deliver = Effect.fn("ReminderCommands.deliver")(function* (
		fence: Fence,
	) {
		const saved = yield* load(fence)
		yield* authorize(fence, saved.execution.identity.actor, "advance")
		yield* sql.withTransaction(
			Effect.gen(function* () {
				const receipt = yield* inputs.notify(
					fence.namespace,
					Execution.CommandKey.make("reminder-notice:" + fence.id),
					{
						chat: saved.record.chat,
						identity: saved.execution.identity,
						content: Prompt.make("[OpenBot] Reminder: " + saved.record.note),
						queue: true,
						notice: { kind: "reminder", ref: saved.record.id },
					},
					{
						executionId: fence.id,
						turn: saved.record.turn,
						step: saved.input.position.step,
					},
				)
				yield* store.commit(
					fence,
					{
						status: "completed",
						events: [
							...(receipt.executionId === fence.id
								? []
								: [
										{
											_tag: "ChildExecution" as const,
											executionId: receipt.executionId,
											step: "notice-input",
										},
									]),
							{ _tag: "Result", resource: saved.execution.record.resource },
						],
					},
					reminders.change(
						saved.execution.identity.owner.organizationId,
						saved.record.id,
						"waiting",
						"done",
					),
				)
			}),
		)
	}, storage)
	const finish = Effect.fn("ReminderCommands.finish")(function* (
		fence: Fence,
		end:
			| { readonly status: "failed"; readonly failure: Execution.Failure }
			| { readonly status: "cancelled"; readonly epoch: number },
	) {
		const saved = yield* load(fence)
		const close = reminders.change(
			saved.execution.identity.owner.organizationId,
			saved.record.id,
			"waiting",
			"cancelled",
		)
		const events = [
			{ _tag: "Result" as const, resource: saved.execution.record.resource },
		]
		if (end.status === "cancelled")
			yield* store.finishCancellation(fence, end.epoch, () =>
				close.pipe(Effect.as(events)),
			)
		else
			yield* store.commit(
				fence,
				{ status: "failed", failure: end.failure, events },
				close,
			)
	}, storage)
	return ReminderCommands.of({ load, authorize, start, deliver, finish })
})

export const layer = Layer.effect(ReminderCommands, make)
