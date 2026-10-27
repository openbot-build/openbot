import { Execution, ExecutionIdentity } from "@openbot-build/domain"
import { Context, Effect, Layer, Schema } from "effect"
import { Prompt } from "effect/ai"
import { SqlClient } from "effect/sql"
import { InputCommands } from "../chats/InputCommands.ts"
import type { Authorize } from "../execution/Engine.ts"
import { Store, storage, type Fence, type Key } from "../execution/Store.ts"
import { DelegationCommands, noticeWorkflowName } from "./DelegationCommands.ts"

const Input = Schema.Struct({ delegationExecutionId: Execution.Id })
const sameIdentity = Schema.toEquivalence(ExecutionIdentity)
const make = Effect.gen(function* () {
	const store = yield* Store
	const delegations = yield* DelegationCommands
	const inputs = yield* InputCommands
	const sql = yield* SqlClient.SqlClient
	const load = Effect.fn("DelegationNotices.load")(function* (key: Key) {
		const notice = yield* store.loadMember(key)
		const input = yield* Schema.decodeUnknownEffect(Input)(notice.input)
		const source = { namespace: key.namespace, id: input.delegationExecutionId }
		const delegation = yield* delegations.load(source)
		if (
			notice.workflow !== noticeWorkflowName ||
			notice.record.resource.kind !== "ChatNotice" ||
			notice.record.resource.id !== delegation.stored.delegation.id ||
			!sameIdentity(notice.identity, delegation.execution.identity) ||
			!Execution.isTerminal(delegation.execution.record.status)
		)
			return yield* Execution.Forbidden.make({})
		return { notice, source, delegation }
	}, storage)
	const authorize: Authorize = (key, actor, mode) =>
		load(key).pipe(
			Effect.flatMap(({ source }) =>
				delegations.authorize(source, actor, mode),
			),
		)
	/** A retry reads the same end and writes no second parent input. */
	const deliver = Effect.fn("DelegationNotices.deliver")(function* (
		fence: Fence,
	) {
		const saved = yield* load(fence)
		yield* authorize(fence, saved.notice.identity.actor, "advance")
		const value = saved.delegation.stored.delegation
		const text = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
			{
				delegation: value.id,
				executionId: saved.source.id,
				bot: value.bot,
				status: saved.delegation.execution.record.status,
				result: value.result,
				failure: saved.delegation.execution.record.failure,
			},
		)
		yield* sql.withTransaction(
			Effect.gen(function* () {
				const input = {
					chat: value.parent.chat,
					identity: saved.notice.identity,
					content: Prompt.make(text),
					queue: true,
					notice: { kind: "delegation", ref: value.id },
				}
				const key = Execution.CommandKey.make(`delegation-notice:${fence.id}`)
				const origin = saved.delegation.origin
				const receipt = yield* origin._tag === "Trigger"
					? inputs.submit(fence.namespace, key, input)
					: inputs.notify(fence.namespace, key, input, {
							executionId: fence.id,
							turn: origin.child.record.position.turn,
							step: origin.child.record.position.step,
						})
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
	const finish = Effect.fn("DelegationNotices.finish")(function* (
		fence: Fence,
		end:
			| { readonly status: "failed"; readonly failure: Execution.Failure }
			| { readonly status: "cancelled"; readonly epoch: number },
	) {
		const saved = yield* load(fence)
		const events = [
			{ _tag: "Result" as const, resource: saved.notice.record.resource },
		]
		if (end.status === "cancelled")
			yield* store.finishCancellation(fence, end.epoch, () =>
				Effect.succeed(events),
			)
		else
			yield* store.commit(
				fence,
				{ status: "failed", failure: end.failure, events },
				Effect.void,
			)
	}, storage)
	return { authorize, deliver, finish }
})
export class DelegationNotices extends Context.Service<
	DelegationNotices,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/bots/DelegationNotices") {}
export const layer = Layer.effect(DelegationNotices, make)
