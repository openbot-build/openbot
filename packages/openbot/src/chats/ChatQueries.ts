import { Store as ExecutionStore } from "../execution/Store.ts"
import * as ToolActivity from "../execution/ToolActivity.ts"
import { ModelRegistry } from "../models/ModelRegistry.ts"
import * as ChatHost from "./ChatHost.ts"
import { Chat, type Item, type Turn } from "@openbot-build/core"
import {
	Authorization,
	type Caller,
	type ChatKind,
} from "@openbot-build/domain"
import { Effect, Array as Arr } from "effect"
import { sql } from "drizzle-orm"
import * as Check from "../authorization/Check.ts"
import { toWhere } from "../authorization/Sql.ts"
import * as Db from "../database/Database.ts"
import { chats } from "../database/Schema.ts"
import { ownerKey } from "../apps/StoredConnections.ts"
import * as ChatRecords from "./ChatRecords.ts"
import { databaseError } from "./ChatEncoding.ts"
import * as StoredChats from "./StoredChats.ts"
import { OpenWork } from "./OpenWork.ts"
import * as Todos from "../plugins/work/Todos.ts"

/** Every entry point uses the caller's current read policy and saved records. */
export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const executions = yield* ExecutionStore
	const models = yield* ModelRegistry
	const records = yield* ChatRecords.make
	const checks = yield* Check.make
	const openWork = yield* OpenWork
	const check = (caller: Caller, id: Chat.Id) =>
		checks.check(caller, {
			action: "read",
			resource: Authorization.Chat.make({
				organizationId: caller.organizationId,
				ownerUserId: caller.userId,
				id,
			}),
		})
	const use = <A, E>(
		caller: Caller,
		chat: Chat.Id,
		work: Effect.Effect<A, E>,
	) => check(caller, chat).pipe(Effect.andThen(work))
	const describe = (caller: Caller, view: Chat.View<ChatHost.Values>) =>
		Effect.gen(function* () {
			const source = records(ownerKey(caller))
			const turn = Chat.currentTurn(view.chat)
			const executionId = yield* source.executionId(turn?.id, view.chat.id)
			const activity =
				executionId === null
					? undefined
					: yield* executions
							.activity({
								namespace: ownerKey(caller),
								id: executionId,
							})
							.pipe(Effect.mapError(databaseError))
			return {
				view,
				items:
					turn === undefined
						? []
						: yield* source.turnLog(view.chat.id, turn.id),
				executionId,
				...(activity === undefined
					? {}
					: {
							activeExecution: {
								id: activity.record.id,
								sequence: activity.record.sequence,
								status: activity.record.status,
							},
						}),
				activeTools:
					activity === undefined || turn === undefined
						? []
						: ToolActivity.active(
								activity.record,
								activity.calls,
								view.chat.id,
								turn.id,
							),
				open: yield* openWork.count(caller.organizationId, view.chat.id),
			}
		})
	const service = {
		describe,
		models: (caller: Caller, chat: Chat.Id) =>
			use(
				caller,
				chat,
				Effect.gen(function* () {
					const { chat: ref } = yield* records(ownerKey(caller)).read(chat)
					const catalog = yield* ChatHost.hostState(ref).kind === "live"
						? models.liveCatalog(caller.organizationId)
						: models.catalog(caller.organizationId)
					return {
						...catalog,
						...(ref.settings.model === undefined
							? {}
							: { selected: ref.settings.model }),
					}
				}),
			),
		get: (caller: Caller, chat: Chat.Id) =>
			use(
				caller,
				chat,
				Effect.gen(function* () {
					return yield* describe(
						caller,
						yield* records(ownerKey(caller)).read(chat),
					)
				}),
			),
		todos: (caller: Caller, chat: Chat.Id) =>
			use(
				caller,
				chat,
				records(ownerKey(caller)).read(chat).pipe(Effect.map(Todos.of)),
			),
		read: (caller: Caller, chat: Chat.Id) =>
			use(caller, chat, records(ownerKey(caller)).read(chat)),
		list: (
			caller: Caller,
			input: { readonly bot?: string; readonly kind?: ChatKind } = {},
		) =>
			Effect.gen(function* () {
				const allowed = yield* checks
					.filter(caller, {
						action: "read",
						kind: "Chat",
						within: ($) =>
							$.and(
								$.eq("organizationId", caller.organizationId),
								$.eq("ownerUserId", caller.userId),
							),
					})
					.pipe(
						Effect.flatMap((condition) =>
							toWhere(condition, {
								organizationId: sql`${caller.organizationId}`,
								ownerUserId: sql`${caller.userId}`,
								id: chats.id,
							}),
						),
					)
				const refs = yield* StoredChats.list(db, ownerKey(caller), {
					...(input.bot === undefined ? {} : { bot: input.bot }),
					kinds:
						input.kind === undefined
							? ["direct", "conversation", "channel", "live"]
							: [input.kind],
					where: allowed,
				})
				return yield* Effect.forEach(refs, (ref) =>
					records(ownerKey(caller))
						.executionId(ref.turn?.id, ref.id)
						.pipe(Effect.map((executionId) => ({ ref, executionId }))),
				)
			}),
		turns: (
			caller: Caller,
			chat: Chat.Id,
			input: { readonly after?: Turn.Id; readonly limit?: number },
		) => use(caller, chat, records(ownerKey(caller)).turns(chat, input)),
		items: (
			caller: Caller,
			chat: Chat.Id,
			input: { readonly before?: Item.Seq; readonly limit?: number },
		) => use(caller, chat, records(ownerKey(caller)).items(chat, input)),
		turn: (caller: Caller, chat: Chat.Id, turn: Turn.Id) =>
			use(
				caller,
				chat,
				Effect.all({
					saved: records(ownerKey(caller)).turn(chat, turn),
					items: records(ownerKey(caller)).turnLog(chat, turn),
				}),
			),
		turnItems: (
			caller: Caller,
			chat: Chat.Id,
			turn: Turn.Id,
			input: { readonly after?: Item.Id; readonly limit?: number },
		) =>
			use(caller, chat, records(ownerKey(caller)).turnItems(chat, turn, input)),
	}
	return {
		...service,
		branches: (caller: Caller, chat: Chat.Id) =>
			Effect.gen(function* () {
				const source = yield* service.read(caller, chat)
				const root = ChatHost.hostState(source.chat).branchOf?.root ?? chat
				const rows = yield* service.list(caller, { kind: "conversation" })
				return Arr.filter(
					rows,
					({ ref }) =>
						ref.id === root || ChatHost.hostState(ref).branchOf?.root === root,
				)
			}),
	}
})
