import { Execution, ExecutionIdentity } from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Context,
	Effect,
	Layer,
	Option,
	Schema,
} from "effect"
import { Prompt } from "effect/ai"
import { SqlClient } from "effect/sql"
import { type Authorize } from "../execution/Engine.ts"
import { Store, storage, type Fence, type Key } from "../execution/Store.ts"
import { latestCall } from "./ToolResults.ts"
import { InputCommands } from "./InputCommands.ts"
import { ToolCommands, noticeWorkflowName } from "./ToolCommands.ts"

const Input = Schema.Struct({ toolExecutionId: Execution.Id })
const sameIdentity = Schema.toEquivalence(ExecutionIdentity)
const make = Effect.gen(function* () {
	const store = yield* Store
	const tools = yield* ToolCommands
	const inputs = yield* InputCommands
	const sql = yield* SqlClient.SqlClient
	const load = Effect.fn("ToolNotices.load")(function* (key: Key) {
		const notice = yield* store.loadMember(key)
		const input = yield* Schema.decodeUnknownEffect(Input)(notice.input)
		const source = { namespace: key.namespace, id: input.toolExecutionId }
		const tool = yield* tools.load(source)
		if (
			notice.workflow !== noticeWorkflowName ||
			notice.record.resource.kind !== "ChatNotice" ||
			notice.record.resource.id !== tool.record.id ||
			!sameIdentity(notice.identity, tool.identity) ||
			!tool.record.detached ||
			!Execution.isTerminal(tool.record.status)
		)
			return yield* Execution.Conflict.make({ id: key.id })
		return { notice, source, tool }
	}, storage)
	const authorize: Authorize = (key, actor, mode) =>
		load(key).pipe(
			Effect.flatMap(({ source }) => tools.authorize(source, actor, mode)),
			Effect.catchCause((cause) => {
				if (Cause.hasInterruptsOnly(cause))
					return Effect.failCause(
						Cause.fromReasons<never>(
							Arr.filter(cause.reasons, Cause.isInterruptReason),
						),
					)
				const reason = cause.reasons[0]
				if (
					cause.reasons.length === 1 &&
					reason?._tag === "Fail" &&
					Schema.is(
						Schema.Union([
							Execution.Forbidden,
							Execution.NotFound,
							Execution.StorageError,
						]),
					)(reason.error)
				) {
					const error = reason.error
					return Effect.failCause(Cause.map(cause, () => error))
				}
				return Effect.fail(Execution.StorageError.make({ cause }))
			}),
		)
	/** Input and its receipt commit with the notice. A retry adds no second message. */
	const deliver = Effect.fn("ToolNotices.deliver")(function* (fence: Fence) {
		const saved = yield* load(fence)
		yield* authorize(fence, saved.notice.identity.actor, "advance")
		const history = yield* store.calls(saved.source)
		const latest = latestCall(saved.tool.record, history)
		const text = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
			{
				toolExecutionId: saved.source.id,
				callId: saved.tool.record.callId,
				tool: saved.tool.record.tool,
				status: saved.tool.record.status,
				failure: saved.tool.record.failure,
				...(Option.isSome(latest) && latest.value.status === "completed"
					? { result: latest.value.result }
					: {}),
			},
		)
		yield* sql.withTransaction(
			Effect.gen(function* () {
				const receipt = yield* inputs.notify(
					fence.namespace,
					Execution.CommandKey.make(`tool-notice:${fence.id}`),
					{
						chat: saved.tool.record.position.chat,
						identity: saved.notice.identity,
						content: Prompt.make("[OpenBot] " + text),
						queue: true,
						notice: { kind: "tool", ref: saved.source.id },
					},
					{
						executionId: fence.id,
						turn: saved.tool.record.position.turn,
						step: saved.tool.record.position.step,
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
							{ _tag: "Result", resource: saved.notice.record.resource },
						],
					},
					Effect.void,
				)
			}),
		)
	}, storage)
	const finish = Effect.fn("ToolNotices.finish")(function* (
		fence: Fence,
		end:
			| { readonly status: "failed"; readonly failure: Execution.Failure }
			| { readonly status: "cancelled"; readonly epoch: number },
	) {
		const saved = yield* load(fence)
		const events = [
			{ _tag: "Result" as const, resource: saved.notice.record.resource },
		]
		if (end.status === "cancelled") {
			yield* store.finishCancellation(fence, end.epoch, () =>
				Effect.succeed(events),
			)
		} else {
			yield* store.commit(
				fence,
				{ status: "failed", failure: end.failure, events },
				Effect.void,
			)
		}
	}, storage)
	return { authorize, deliver, finish }
})
export class ToolNotices extends Context.Service<
	ToolNotices,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/chats/ToolNotices") {}
export const layer = Layer.effect(ToolNotices, make)
