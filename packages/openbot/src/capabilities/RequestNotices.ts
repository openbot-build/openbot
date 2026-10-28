import { ChatStoreRepository, Store as CoreStore } from "@openbot-build/core"
import { Execution, ExecutionIdentity } from "@openbot-build/domain"
import { Array as Arr, Context, Effect, Layer, Option, Schema } from "effect"
import { Prompt } from "effect/ai"
import { SqlClient } from "effect/sql"
import { AppApprovals } from "../apps/AppApprovals.ts"
import * as ChatHost from "../chats/ChatHost.ts"
import { InputCommands, type Input } from "../chats/InputCommands.ts"
import * as StoredChats from "../chats/StoredChats.ts"
import { TurnAccess } from "../chats/TurnAccess.ts"
import * as Db from "../database/Database.ts"
import { type Authorize } from "../execution/Engine.ts"
import { Store, storage, type Fence, type Key } from "../execution/Store.ts"
import * as Todos from "../plugins/work/Todos.ts"
import { approvedCallId } from "./Approvals.ts"
import { describe } from "./Capability.ts"
import { RequestCommands, noticeWorkflowName } from "./RequestCommands.ts"
import { type Stored } from "./Requests.ts"

const Reference = Schema.Struct({ requestExecutionId: Execution.Id })
const sameIdentity = Schema.toEquivalence(ExecutionIdentity)
const reason = (stored: Stored) =>
	Arr.join(
		Arr.filter(
			[
				stored.request.decision?.reason ?? "The request was denied.",
				stored.request.decision?.question === undefined
					? ""
					: `Question: ${stored.request.decision.question}`,
			],
			(line) => line.length > 0,
		),
		" ",
	)

export interface Service {
	readonly authorize: Authorize
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

export class RequestNotices extends Context.Service<RequestNotices, Service>()(
	"@openbot-build/openbot/capabilities/RequestNotices",
) {}

const make = Effect.gen(function* () {
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const store = yield* Store
	const commands = yield* RequestCommands
	const inputs = yield* InputCommands
	const access = yield* TurnAccess
	const apps = yield* AppApprovals
	const definition = yield* CoreStore.define({
		stores: { [ChatHost.chatHostId]: ChatHost.chatHostStore, ...Todos.stores },
		schemaVersion: "chat/1",
	})
	const load = Effect.fn("RequestNotices.load")(function* (key: Key) {
		const notice = yield* store.loadMember(key)
		const reference = yield* Schema.decodeUnknownEffect(Reference)(notice.input)
		const requestKey = {
			namespace: key.namespace,
			id: reference.requestExecutionId,
		}
		const saved = yield* commands.load(requestKey)
		if (
			notice.workflow !== noticeWorkflowName ||
			notice.record.resource.kind !== "RequestNotice" ||
			notice.record.resource.id !== saved.stored.request.id ||
			!sameIdentity(notice.identity, saved.execution.identity) ||
			saved.continuation !== "chat" ||
			!Execution.isTerminal(saved.execution.record.status) ||
			saved.stored.request.status === "pending" ||
			saved.stored.request.status === "cancelled"
		)
			return yield* Execution.Forbidden.make({})
		return { notice, requestKey, ...saved }
	}, storage)
	const authorize: Authorize = (key, actor, mode) =>
		load(key).pipe(
			Effect.flatMap(({ requestKey }) =>
				commands.authorize(requestKey, actor, mode),
			),
		)
	/** State, App approval, input, result and outbox writes share one transaction. */
	const deliver = Effect.fn("RequestNotices.deliver")(
		function* (fence: Fence) {
			const saved = yield* load(fence)
			yield* authorize(fence, saved.notice.identity.actor, "advance")
			const chats = yield* ChatStoreRepository.make({
				definition,
				persistence: StoredChats.persistence(db, fence.namespace),
			})
			const { request } = saved.stored
			const source = yield* store.loadMember(saved.sourceKey)
			yield* sql.withTransaction(
				Effect.gen(function* () {
					yield* StoredChats.lock(db, fence.namespace, request.chat)
					const current = yield* store.loadMember(fence)
					if (current.generation !== fence.generation)
						return yield* Execution.Conflict.make({ id: fence.id })
					if (current.record.status === "completed") return
					if (
						current.record.status === "cancelling" ||
						Execution.isTerminal(current.record.status)
					)
						return yield* Execution.Conflict.make({ id: fence.id })
					yield* store.lock(fence)
					yield* authorize(fence, saved.notice.identity.actor, "advance")
					const view = yield* chats.read(request.chat)
					const open = yield* access.notice(view.chat, source.identity)
					const allowed = request.status === "allowed"
					const plan = request.capability.action === "plans.run"
					let changed = false
					if (open && request.app !== undefined)
						changed =
							(yield* apps.decide(fence.namespace, request.app, allowed)) ===
							"Changed"
					if (open && plan && allowed)
						yield* chats.modifyEffect({
							chat: request.chat,
							update: (view) =>
								Effect.succeed([
									undefined,
									Option.some({
										chat: {
											settings: { ...view.chat.settings, mode: "build" },
										},
									}),
								] as const),
						})
					const call = saved.stored.call
					const input: Input = {
						chat: request.chat,
						identity: source.identity,
						queue: plan || call?.source !== undefined,
						notice: { kind: plan ? "plan" : "request", ref: request.id },
						content: Prompt.make(
							!open
								? `[OpenBot] Your request ${request.id} was ${allowed ? "allowed" : "not allowed: " + reason(saved.stored)}. This work is closed.`
								: plan
									? allowed
										? "[OpenBot] Your plan is approved. Carry it out now, and keep the todo list up to date."
										: `[OpenBot] Your plan was not approved: ${reason(saved.stored)}\n\nYou stay in plan mode.`
									: allowed && changed
										? `[OpenBot] Your request ${request.id} was allowed, but the App connection or call changed after it. Ask again.`
										: allowed && call !== undefined
											? `[OpenBot] Your request ${request.id} was allowed. OpenBot runs ${call.name} now.`
											: allowed
												? `[OpenBot] Your request ${request.id} to ${describe(request.capability)} was allowed. You can do it now.`
												: `[OpenBot] Your request ${request.id} to ${describe(request.capability)} was not allowed: ${reason(saved.stored)}`,
						),
						...(open && !plan && allowed && !changed && call !== undefined
							? {
									approved: {
										id: approvedCallId(request.id),
										name: call.name,
										params: call.params,
									},
								}
							: {}),
					}
					const receipt = yield* inputs.notify(
						fence.namespace,
						Execution.CommandKey.make(`request-notice:${fence.id}`),
						input,
						{
							executionId: fence.id,
							turn: request.turn,
							step: 0,
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
								{ _tag: "Result", resource: current.record.resource },
							],
						},
						Effect.void,
					)
				}),
			)
		},
		Effect.scoped,
		storage,
	)
	const finish = Effect.fn("RequestNotices.finish")(function* (
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
	return RequestNotices.of({ authorize, deliver, finish })
})

export const layer = Layer.effect(RequestNotices, make)
