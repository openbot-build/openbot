import {
	Chat,
	ChatStoreRepository,
	Store as CoreStore,
	Turn,
} from "@openbot-build/core"
import { Authorization, Caller, Execution } from "@openbot-build/domain"
import { and, eq, notInArray } from "drizzle-orm"
import { Array as Arr, Effect, Option, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { ownerKey } from "../apps/StoredConnections.ts"
import * as Check from "../authorization/Check.ts"
import * as Db from "../database/Database.ts"
import { executions } from "../database/ExecutionSchema.ts"
import { type Authorize } from "../execution/Engine.ts"
import { Observation } from "../execution/Observation.ts"
import {
	Store,
	storage,
	transactionFailures,
	type Fence,
	type Key,
} from "../execution/Store.ts"
import type { End } from "../execution/Program.ts"
import * as Todos from "../plugins/work/Todos.ts"
import * as ChatHost from "./ChatHost.ts"
import * as StoredChats from "./StoredChats.ts"
import { LiveConnections } from "./live/LiveConnections.ts"
import { inExecution } from "./ChatEncoding.ts"

export const workflowName = "openbot.chat-control"
const Input = Schema.Struct({
	chat: Chat.Id,
	mode: Schema.Literals(["interrupt", "delete"]),
	delegations: Schema.Boolean,
	targets: Schema.Array(
		Schema.Struct({ namespace: Schema.String, id: Execution.Id }),
	),
})
const sameCaller = Schema.toEquivalence(Caller)

/** A stop command waits for saved work to release its resources. It opens no Chat runtime. */
export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const store = yield* Store
	const observation = yield* Observation
	const live = yield* LiveConnections
	const checks = yield* Check.make
	const definition = yield* CoreStore.define({
		stores: { [ChatHost.chatHostId]: ChatHost.chatHostStore, ...Todos.stores },
		schemaVersion: "chat/1",
	})
	const records = (namespace: string) =>
		ChatStoreRepository.make({
			definition,
			persistence: StoredChats.persistence(db, namespace),
		})
	const check = (
		caller: Caller,
		owner: { readonly organizationId: string; readonly userId: string },
		chat: Chat.Id,
		action: "read" | "write",
	) =>
		checks
			.check(caller, {
				action,
				resource: Authorization.Chat.make({
					organizationId: owner.organizationId,
					ownerUserId: owner.userId,
					id: chat,
				}),
			})
			.pipe(
				Effect.catchTags({
					Forbidden: () => Effect.fail(Execution.Forbidden.make({})),
					Pending: () => Effect.fail(Execution.Forbidden.make({})),
				}),
				storage,
			)
	const active = (namespace: string, chat: Chat.Id) =>
		db
			.select({
				id: executions.id,
				kind: executions.resourceKind,
				resourceId: executions.resourceId,
			})
			.from(executions)
			.where(
				and(
					eq(executions.namespace, namespace),
					eq(executions.contextKind, "Chat"),
					eq(executions.contextId, chat),
					notInArray(executions.status, [
						"completed",
						"failed",
						"cancelled",
						"interrupted",
					]),
				),
			)
			.pipe(storage)
	const load = (key: Key) =>
		Effect.gen(function* () {
			const execution = yield* store.loadMember(key)
			const input = yield* Schema.decodeUnknownEffect(Input)(execution.input)
			if (
				execution.workflow !== workflowName ||
				execution.record.resource.kind !== "ChatControl" ||
				execution.record.resource.id !== input.chat
			)
				return yield* Execution.Forbidden.make({})
			return { execution, input }
		}).pipe(storage)
	const authorize: Authorize = (key, actor, mode) =>
		Effect.gen(function* () {
			const saved = yield* load(key)
			if (
				(mode === "advance" || mode === "replay") &&
				!sameCaller(actor, saved.execution.identity.actor)
			)
				return yield* Execution.Forbidden.make({})
			yield* check(
				actor,
				saved.execution.identity.owner,
				saved.input.chat,
				mode === "read" ? "read" : "write",
			)
		})
	const cancel = (
		controller: Key,
		targets: ReadonlyArray<Key>,
		caller: Caller,
		guard: Effect.Effect<
			void,
			Execution.Conflict | Execution.NotFound | Execution.StorageError
		> = Effect.void,
	) =>
		Effect.forEach(
			targets,
			(target) =>
				store.get(target).pipe(
					Effect.flatMap((current) =>
						Execution.isTerminal(current.status)
							? Effect.void
							: store
									.cancel(
										target,
										Execution.CommandKey.make(
											"chat-control:" + controller.id + ":" + target.id,
										),
										caller,
										guard,
									)
									.pipe(
										Effect.asVoid,
										Effect.catchTag("ExecutionConflict", (error) =>
											store
												.get(target)
												.pipe(
													Effect.flatMap((current) =>
														Execution.isTerminal(current.status)
															? Effect.void
															: Effect.fail(error),
													),
												),
										),
									),
					),
				),
			{ discard: true },
		)
	const command = (
		caller: Caller,
		commandKey: Execution.CommandKey,
		chat: Chat.Id,
		mode: "interrupt" | "delete",
		delegations = false,
	) =>
		Effect.gen(function* () {
			yield* check(caller, caller, chat, "write")
			const namespace = ownerKey(caller)
			return yield* store.accept(
				namespace,
				commandKey,
				{ actor: caller, body: { caller, chat, mode, delegations } },
				(create) =>
					Effect.gen(function* () {
						yield* StoredChats.lock(db, namespace, chat)
						const chats = yield* records(namespace)
						const view = yield* chats.read(chat)
						const host = ChatHost.hostState(view.chat)
						if (host.control !== undefined)
							return yield* Chat.Conflict.make({
								chat,
								message: "The Chat has a delete command in progress.",
							})
						if (
							mode === "delete" &&
							host.kind !== "direct" &&
							host.kind !== "channel" &&
							host.kind !== "live"
						)
							return yield* Chat.Conflict.make({
								chat,
								message:
									"Only direct Chats, channel Chats and live Chats can be deleted.",
							})
						const rows = yield* active(namespace, chat)
						const turn = view.chat.turn
						const targets = Arr.map(
							Arr.filter(
								rows,
								(row) =>
									mode === "delete" ||
									(row.kind === "Turn" &&
										turn !== undefined &&
										!Turn.isTerminal(turn.status) &&
										row.resourceId === turn.id) ||
									(delegations &&
										Arr.contains(
											["Delegation", "Reminder", "Request"],
											row.kind,
										)),
							),
							(row) => ({ namespace, id: Execution.Id.make(row.id) }),
						)
						const key = yield* create({
							workflow: workflowName,
							resource: { kind: "ChatControl", id: chat },
							identity: {
								owner: {
									organizationId: caller.organizationId,
									userId: caller.userId,
								},
								actor: caller,
							},
							input: { chat, mode, delegations, targets },
						})
						if (mode === "delete")
							yield* chats.modifyEffect({
								chat,
								update: (current) =>
									Effect.succeed([
										undefined,
										Option.some({
											chat: {
												business: {
													...current.chat.business,
													[ChatHost.chatHostId]: {
														...ChatHost.hostState(current.chat),
														control: key.id,
													},
												},
											},
										}),
									] as const),
							})
						yield* cancel(key, targets, caller)
						return { executionId: key.id, start: true }
					}).pipe(Effect.scoped, inExecution),
			)
		})
	const release = (fence: Fence) =>
		Effect.gen(function* () {
			const saved = yield* load(fence)
			let targets = saved.input.targets
			while (true) {
				yield* store.guard(fence)
				yield* cancel(
					fence,
					targets,
					saved.execution.identity.actor,
					store.guard(fence),
				)
				yield* Effect.forEach(
					targets,
					(target) => observation.observe(target, 0).pipe(Stream.runDrain),
					{ concurrency: "unbounded", discard: true },
				)
				if (saved.input.mode !== "delete") return
				targets = Arr.map(
					yield* active(fence.namespace, saved.input.chat),
					(row) => ({
						namespace: fence.namespace,
						id: Execution.Id.make(row.id),
					}),
				)
				if (targets.length === 0) {
					yield* live.release(fence.namespace, saved.input.chat)
					return
				}
			}
		})
	const finish = (fence: Fence, end: End | { readonly status: "completed" }) =>
		Effect.gen(function* () {
			const saved = yield* load(fence)
			while (true) {
				yield* release(fence)
				const done = yield* sql
					.withTransaction(
						Effect.gen(function* () {
							yield* StoredChats.lock(db, fence.namespace, saved.input.chat)
							yield* store.lock(fence)
							yield* store.guard(fence)
							if (
								saved.input.mode === "delete" &&
								(yield* active(fence.namespace, saved.input.chat)).length !== 0
							)
								return false
							const change = Effect.gen(function* () {
								if (saved.input.mode !== "delete") return
								const chats = yield* records(fence.namespace)
								const view = yield* chats.read(saved.input.chat)
								if (ChatHost.hostState(view.chat).control !== fence.id)
									return yield* Execution.Conflict.make({ id: fence.id })
								if (end.status === "completed") {
									yield* authorize(
										fence,
										saved.execution.identity.actor,
										"advance",
									)
									yield* StoredChats.remove(
										db,
										fence.namespace,
										saved.input.chat,
									)
								} else
									yield* chats.modifyEffect({
										chat: saved.input.chat,
										update: (current) => {
											const { control: _, ...host } = ChatHost.hostState(
												current.chat,
											)
											return Effect.succeed([
												undefined,
												Option.some({
													chat: {
														business: {
															...current.chat.business,
															[ChatHost.chatHostId]: host,
														},
													},
												}),
											] as const)
										},
									})
							}).pipe(Effect.scoped)
							if (end.status === "cancelled")
								yield* store.finishCancellation(fence, end.epoch, () =>
									change.pipe(Effect.as([])),
								)
							else yield* store.commit(fence, end, change)
							return true
						}),
					)
					.pipe(transactionFailures, inExecution)
				if (done) return
			}
		})
	const work = (fence: Fence) =>
		Effect.gen(function* () {
			const saved = yield* load(fence)
			yield* authorize(fence, saved.execution.identity.actor, "advance")
			yield* finish(fence, { status: "completed" })
		})
	return { command, authorize, work, finish }
})
