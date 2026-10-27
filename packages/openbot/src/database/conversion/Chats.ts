import { ChatState, Item } from "@openbot-build/core"
import { Array as Arr, Effect, HashMap, Schema } from "effect"
import { Prompt } from "effect/ai"
import { SqlClient } from "effect/sql"
import { Secrets } from "../../secrets/Secrets.ts"
import * as Authority from "./Authority.ts"
import * as Imported from "./Executions.ts"
import * as Legacy from "./LegacyChats.ts"
import * as Version from "./LegacyV1.ts"
import * as Progress from "./Progress.ts"

const json = Schema.fromJsonString(Schema.Json)
const encode = Schema.encodeEffect(json)
const parse = Schema.decodeEffect(json)
const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
	Schema.decodeEffect(Schema.fromJsonString(schema), {
		onExcessProperty: "error",
	})
export class InvalidChat extends Schema.TaggedError<
	InvalidChat,
	{ readonly brand: unique symbol }
>()("DataUpgradeInvalidChat", { message: Schema.String }) {}
const invalid = (message: string) => InvalidChat.make({ message })
const ownerOf = (namespace: string) =>
	Schema.decodeEffect(Version.Owner)(namespace).pipe(
		Effect.map(([organizationId, userId]) => ({ organizationId, userId })),
	)
const stoppedTurn = (value: typeof Legacy.Turn.Type, at: number) =>
	value.status._tag === "Running"
		? { ...value, status: { _tag: "Interrupted" as const }, completedAt: at }
		: value
const turnStatus = (
	value: typeof Legacy.Turn.Type,
): Imported.RecordInput["status"] =>
	value.status._tag === "Completed"
		? "completed"
		: value.status._tag === "Failed"
			? "failed"
			: "interrupted"

/** The old unresolved calls remain in history, but cannot become fresh tool work. */
const finishState = (state: typeof Legacy.State.Type) =>
	Effect.gen(function* () {
		const prompt = yield* Schema.decodeEffect(Item.Entry.fields.content)(
			state.conversation.context.prompt,
		)
		const calls = Arr.fromIterable(
			HashMap.values(ChatState.pendingCalls(prompt)),
		)
		const next =
			calls.length === 0
				? prompt
				: Prompt.concat(
						prompt,
						Prompt.make([
							{
								role: "tool",
								content: Arr.map(calls, (call) =>
									Prompt.toolResultPart({
										providerExecuted: false,
										id: call.id,
										name: call.name,
										isFailure: true,
										result: {
											status: "interrupted",
											reason: "data_move",
											message:
												"The old call stopped. Start new work to try again.",
										},
									}),
								),
							},
						]),
					)
		const content = yield* Schema.encodeEffect(Item.Entry.fields.content)(next)
		return {
			...state,
			conversation: {
				...state.conversation,
				closed: true,
				context: {
					...state.conversation.context,
					prompt: yield* Schema.decodeUnknownEffect(Legacy.Prompt)(content),
				},
			},
		}
	})

export const steps = [
	"chat-items",
	"chat-turns",
	"chats",
	"chat-tools",
	"chat-requests",
	"chat-delegations",
] as const

/** The maintenance caller owns the outer lock. Each source batch and its links commit together. */
export const run = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const progress = yield* Progress.make
	const imported = yield* Imported.make
	const [upgrade] = yield* sql<{
		started_at: string
	}>`select started_at from openbot_data_upgrades where version = ${Progress.version}`
	if (upgrade === undefined)
		return yield* invalid("The data move has no start record.")
	const at = yield* Schema.decodeEffect(Schema.Finite)(
		Number(upgrade.started_at),
	)
	const write = (
		input: Omit<Imported.RecordInput, "input"> & {
			readonly owner: typeof Authority.Owner.Type
			readonly history: Schema.Json
			readonly reason: Imported.Input["reason"]
		},
	) => {
		const { owner, history, reason, ...record } = input
		return imported.write({
			...record,
			input: {
				_tag: "Imported",
				format: 1,
				source: Version.source,
				owner,
				authority: Authority.missing(owner),
				reason,
				history,
			},
		})
	}
	const chatOf = (namespace: string, id: string) =>
		Effect.gen(function* () {
			const [row] = yield* sql<{
				body: string
			}>`select body from openbot_chats where namespace = ${namespace} and id = ${id}`
			if (row === undefined)
				return yield* invalid("A saved record has no Chat.")
			const value = yield* decode(Legacy.Chat)(row.body)
			const host = yield* Schema.decodeUnknownEffect(Legacy.Host)(
				value.business[Legacy.hostKey],
			)
			const owner = yield* ownerOf(namespace)
			if (
				value.id !== id ||
				host.chain.organizationId !== owner.organizationId ||
				(host.chain.owner ?? host.chain.userId) !== owner.userId
			)
				return yield* invalid("The Chat owner does not match its namespace.")
			return { value, host, owner }
		})
	const turnExists = (namespace: string, chat: string, turn: string) =>
		Effect.gen(function* () {
			const [row] = yield* sql<{
				id: string
			}>`select id from openbot_chat_turns where namespace = ${namespace} and chat = ${chat} and id = ${turn}`
			if (row === undefined)
				return yield* invalid("A saved record has no Turn.")
		})
	const batch = <A, E>(step: {
		readonly name: string
		readonly read: (
			cursor: string | null,
			limit: number,
		) => Effect.Effect<ReadonlyArray<A>, E>
		readonly key: (row: A) => string
		readonly convert: (row: A) => Effect.Effect<void, E>
	}) =>
		Effect.gen(function* () {
			let complete = false
			while (!complete) complete = (yield* progress.batch(step, 100)).complete
		})
	type ItemRow = {
		key: string
		namespace: string
		chat: string
		seq: number
		id: string
		turn: string | null
		value: string
	}
	yield* batch({
		name: "chat-items",
		read: (cursor, limit) =>
			sql<ItemRow>`select json_build_array(namespace, chat, seq)::text as key, namespace, chat, seq, id, turn, value from openbot_chat_items where (${cursor}::text is null or json_build_array(namespace, chat, seq)::text > ${cursor}) order by json_build_array(namespace, chat, seq)::text limit ${limit}`,
		key: (row) => row.key,
		convert: (row) =>
			Effect.gen(function* () {
				const item = yield* decode(Legacy.Item)(row.value)
				yield* Schema.decodeEffect(Item.Entry.fields.content)(item.content)
				const chat = yield* chatOf(row.namespace, row.chat)
				if (
					item.id !== row.id ||
					item.seq !== row.seq ||
					item.seq < 1 ||
					item.seq > chat.value.seq ||
					(item.origin?.turn ?? null) !== row.turn ||
					(item.origin !== undefined && item.origin.chat !== row.chat)
				)
					return yield* invalid("The Item indexes do not match its record.")
				if (item.origin !== undefined)
					yield* turnExists(row.namespace, row.chat, item.origin.turn)
				yield* progress.record("chat-item", row.key, "converted", {
					id: row.id,
					chat: row.chat,
					seq: row.seq,
					value: yield* parse(row.value),
				})
			}),
	})
	type TurnRow = {
		key: string
		namespace: string
		chat: string
		id: string
		value: string
	}
	yield* batch({
		name: "chat-turns",
		read: (cursor, limit) =>
			sql<TurnRow>`select json_build_array(namespace, chat, id)::text as key, namespace, chat, id, value from openbot_chat_turns where (${cursor}::text is null or json_build_array(namespace, chat, id)::text > ${cursor}) order by json_build_array(namespace, chat, id)::text limit ${limit}`,
		key: (row) => row.key,
		convert: (row) =>
			Effect.gen(function* () {
				const turn = yield* decode(Legacy.Turn)(row.value)
				const chat = yield* chatOf(row.namespace, row.chat)
				if (turn.id !== row.id || turn.chat !== row.chat)
					return yield* invalid("The Turn indexes do not match its record.")
				const [other] = yield* sql<{
					id: string
				}>`select id from openbot_chat_turns where namespace = ${row.namespace} and id = ${row.id} and chat <> ${row.chat} limit 1`
				if (other !== undefined)
					return yield* invalid("The same Turn ID belongs to two Chats.")
				const items = yield* sql<{
					value: string
				}>`select value from openbot_chat_items where namespace = ${row.namespace} and chat = ${row.chat} and turn = ${row.id} order by seq`
				const entries = yield* Effect.forEach(items, (item) =>
					decode(Legacy.Item)(item.value),
				)
				for (const id of Arr.dedupe([...turn.items, ...turn.input])) {
					const [found] = yield* sql<{
						id: string
					}>`select id from openbot_chat_items where namespace = ${row.namespace} and chat = ${row.chat} and id = ${id}`
					if (found === undefined)
						return yield* invalid("A Turn names an Item that is missing.")
				}
				const prompt = yield* Effect.forEach(entries, (entry) =>
					Schema.decodeEffect(Item.Entry.fields.content)(entry.content),
				).pipe(
					Effect.map((prompts) =>
						Arr.reduce(prompts, Prompt.empty, Prompt.concat),
					),
				)
				const pending = ChatState.pendingCalls(prompt)
				const approvals = ChatState.openApprovals(prompt)
				const unknown =
					turn.status._tag !== "Running" && turn.status._tag !== "Interrupted"
						? []
						: Arr.filter(
								Arr.fromIterable(HashMap.values(pending)),
								(call) =>
									!Arr.some(
										approvals,
										(approval) => approval.toolCall.id === call.id,
									),
							)
				const calls = yield* Effect.forEach(unknown, (call, index) =>
					Effect.gen(function* () {
						return {
							step: `old-tool:${index}:${call.id}`,
							attempt: 1,
							status: "outcome_unknown" as const,
							input: yield* Schema.encodeEffect(
								Schema.toCodecJson(Prompt.ToolCallPart),
							)(call),
							result: null,
						}
					}),
				)
				const key = yield* write({
					namespace: row.namespace,
					collection: "turn",
					sourceKey: row.key,
					resource: { kind: "Turn", id: row.id },
					context: { kind: "Chat", id: row.chat },
					owner: chat.owner,
					history: yield* parse(row.value),
					reason:
						unknown.length > 0
							? "OutsideResultUnknown"
							: turn.status._tag === "Running"
								? "OriginalCallerMissing"
								: "History",
					status: unknown.length > 0 ? "outcome_unknown" : turnStatus(turn),
					calls,
					createdAt: turn.startedAt,
					updatedAt: turn.completedAt ?? at,
				})
				if (turn.status._tag === "Running")
					yield* sql`update openbot_chat_turns set value = ${yield* encode(stoppedTurn(turn, at))} where namespace = ${row.namespace} and chat = ${row.chat} and id = ${row.id}`
				yield* progress.record(
					"turn",
					row.key,
					turn.status._tag === "Running" ? "needs_authorization" : "converted",
					{ ...key, chat: row.chat, turn: row.id },
				)
			}),
	})
	type ChatRow = {
		key: string
		namespace: string
		id: string
		body: string
		state: string
		bot: string
		kind: string
		status: string
		turn: string | null
		revision: number
		inbox_size: number
		created_at: string
		updated_at: string
	}
	yield* batch({
		name: "chats",
		read: (cursor, limit) =>
			sql<ChatRow>`select json_build_array(namespace, id)::text as key, namespace, id, body, state, bot, kind, status, turn, revision, inbox_size, created_at, updated_at from openbot_chats where (${cursor}::text is null or json_build_array(namespace, id)::text > ${cursor}) order by json_build_array(namespace, id)::text limit ${limit}`,
		key: (row) => row.key,
		convert: (row) =>
			Effect.gen(function* () {
				const { value, host, owner } = yield* chatOf(row.namespace, row.id)
				const state = yield* decode(Legacy.State)(row.state)
				yield* Schema.decodeEffect(Item.Entry.fields.content)(
					state.conversation.context.prompt,
				)
				if (
					row.bot !== host.bot ||
					row.kind !== host.kind ||
					row.status !== (value.turn?.status._tag ?? "Idle") ||
					row.turn !== (value.turn?.id ?? null) ||
					row.revision !== value.revision ||
					row.inbox_size !== value.inbox.length ||
					Number(row.created_at) !== value.createdAt
				)
					return yield* invalid("The Chat indexes do not match its record.")
				const [count] = yield* sql<{
					count: number
					ids: number
					last: number | null
				}>`select count(*)::float8 as count, count(distinct id)::float8 as ids, max(seq)::float8 as last from openbot_chat_items where namespace = ${row.namespace} and chat = ${row.id}`
				if (
					count?.count !== value.seq ||
					count.ids !== value.seq ||
					(count.last ?? 0) !== value.seq
				)
					return yield* invalid(
						"The Chat Item log has a missing or repeated Item.",
					)
				if (value.turn !== undefined) {
					const [saved] = yield* sql<{
						value: string
					}>`select value from openbot_chat_turns where namespace = ${row.namespace} and chat = ${row.id} and id = ${value.turn.id}`
					if (
						saved === undefined ||
						!Schema.toEquivalence(Schema.Json)(
							yield* parse(saved.value),
							stoppedTurn(value.turn, at),
						)
					)
						return yield* invalid(
							"The current Turn does not match its history record.",
						)
				}
				if (
					Arr.dedupe(Arr.map(value.inbox, (entry) => entry.id)).length !==
					value.inbox.length
				)
					return yield* invalid("The old Chat queue repeats an input ID.")
				for (const entry of value.inbox) {
					yield* Schema.decodeEffect(Item.Entry.fields.content)(entry.content)
					const inputKey = yield* encode([row.namespace, row.id, entry.id])
					const key = yield* write({
						namespace: row.namespace,
						collection: "chat-input",
						sourceKey: inputKey,
						resource: { kind: "ChatInput", id: entry.id },
						context: { kind: "Chat", id: row.id },
						owner,
						history: entry,
						reason: "OriginalCallerMissing",
						status: "interrupted",
						createdAt: value.createdAt,
						updatedAt: at,
					})
					yield* progress.record(
						"chat-input",
						inputKey,
						"needs_authorization",
						{ ...key, chat: row.id, item: entry.id },
					)
				}
				const pending =
					value.inbox.length > 0 || value.turn?.status._tag === "Running"
				const key = yield* write({
					namespace: row.namespace,
					collection: "chat",
					sourceKey: row.key,
					resource: { kind: "Chat", id: row.id },
					owner,
					history: {
						chat: yield* parse(row.body),
						state: yield* parse(row.state),
					},
					reason: pending ? "OriginalCallerMissing" : "History",
					status: pending ? "interrupted" : "completed",
					createdAt: value.createdAt,
					updatedAt: pending ? at : Number(row.updated_at),
				})
				// Old inputs have no caller proof. Keep them in sealed history, never in a live queue.
				const next = {
					...value,
					inbox: [],
					...(value.turn === undefined
						? {}
						: { turn: stoppedTurn(value.turn, at) }),
				}
				yield* sql`update openbot_chats set body = ${yield* encode(next)}, state = ${yield* encode(yield* finishState(state))}, status = ${next.turn?.status._tag ?? "Idle"}, inbox_size = 0, runner_seen_at = null where namespace = ${row.namespace} and id = ${row.id}`
				yield* progress.record(
					"chat",
					row.key,
					pending ? "needs_authorization" : "converted",
					{ ...key, chat: row.id },
				)
			}),
	})
	type ToolRow = {
		key: string
		namespace: string
		id: string
		chat: string
		status: string
		body: string
		started_at: string
	}
	yield* batch({
		name: "chat-tools",
		read: (cursor, limit) =>
			sql<ToolRow>`select json_build_array(namespace, id)::text as key, namespace, id, chat, status, body, started_at from openbot_operations where (${cursor}::text is null or json_build_array(namespace, id)::text > ${cursor}) order by json_build_array(namespace, id)::text limit ${limit}`,
		key: (row) => row.key,
		convert: (row) =>
			Effect.gen(function* () {
				const value = yield* decode(Legacy.Operation)(row.body)
				const chat = yield* chatOf(row.namespace, row.chat)
				yield* turnExists(row.namespace, row.chat, value.turn)
				if (
					value.id !== row.id ||
					value.chat !== row.chat ||
					value.status._tag !== row.status ||
					value.startedAt !== Number(row.started_at)
				)
					return yield* invalid("The tool indexes do not match its record.")
				const unknown =
					value.status._tag === "Running" || value.status._tag === "Interrupted"
				const key = yield* write({
					namespace: row.namespace,
					collection: "tool",
					sourceKey: row.key,
					resource: { kind: "ToolCall", id: row.id },
					context: { kind: "Chat", id: row.chat },
					owner: chat.owner,
					history: yield* parse(row.body),
					reason: unknown ? "OutsideResultUnknown" : "History",
					status: unknown
						? "outcome_unknown"
						: value.status._tag === "Completed"
							? "completed"
							: value.status._tag === "Failed"
								? "failed"
								: "cancelled",
					createdAt: value.startedAt,
					updatedAt: value.endedAt ?? at,
					calls: unknown
						? [
								{
									step: "old-tool",
									attempt: 1,
									status: "outcome_unknown",
									input: { callId: value.callId, tool: value.tool },
									result: null,
								},
							]
						: value.status._tag === "Completed"
							? [
									{
										step: "old-tool",
										attempt: 1,
										status: "completed",
										input: { callId: value.callId, tool: value.tool },
										result: value.status.result,
									},
								]
							: [],
				})
				if (value.status._tag === "Running")
					yield* sql`update openbot_operations set status = 'Interrupted', body = ${yield* encode({ ...value, status: { _tag: "Interrupted" }, endedAt: at })} where namespace = ${row.namespace} and id = ${row.id}`
				yield* progress.record(
					"tool",
					row.key,
					unknown ? "needs_authorization" : "converted",
					{ ...key, chat: row.chat, tool: row.id },
				)
			}),
	})
	type BotRow = {
		key: string
		organization_id: string
		id: string
		owner: string
		scope: string
		status: string
		body: string
	}
	const readBot = (kind: string) => (cursor: string | null, limit: number) =>
		sql<BotRow>`select json_build_array(organization_id, id)::text as key, organization_id, id, owner, scope, status, body from openbot_bot_records where kind = ${kind} and (${cursor}::text is null or json_build_array(organization_id, id)::text > ${cursor}) order by json_build_array(organization_id, id)::text limit ${limit}`
	yield* batch({
		name: "chat-requests",
		read: readBot("request"),
		key: (row) => row.key,
		convert: (row) =>
			Effect.gen(function* () {
				const stored = yield* decode(Legacy.Request)(row.body)
				const value = stored.request
				const owner = {
					organizationId: stored.chain.organizationId,
					userId: stored.chain.owner ?? stored.chain.userId,
				}
				const namespace = yield* encode([owner.organizationId, owner.userId])
				yield* chatOf(namespace, value.chat)
				yield* turnExists(namespace, value.chat, value.turn)
				const decider =
					value.approver._tag === "Person"
						? "person:" + value.approver.userId
						: "bot:" + value.approver.bot
				if (
					row.id !== value.id ||
					row.organization_id !== owner.organizationId ||
					row.scope !== value.chat ||
					row.owner !== decider ||
					row.status !== value.status
				)
					return yield* invalid("The request indexes do not match its record.")
				const key = yield* write({
					namespace,
					collection: "request",
					sourceKey: row.key,
					resource: { kind: "Request", id: value.id },
					context: { kind: "Chat", id: value.chat },
					owner,
					history: yield* parse(row.body),
					reason:
						value.status === "pending" ? "OriginalCallerMissing" : "History",
					status:
						value.status === "pending"
							? "interrupted"
							: value.status === "cancelled"
								? "cancelled"
								: "completed",
					createdAt: value.createdAt,
					updatedAt: value.decision?.at ?? at,
				})
				// Keep the pending decision and its exact call. The old request grants no new authority.
				yield* progress.record(
					"request",
					row.key,
					value.status === "pending" ? "needs_authorization" : "converted",
					{ ...key, request: value.id },
				)
			}),
	})
	yield* batch({
		name: "chat-delegations",
		read: readBot("delegation"),
		key: (row) => row.key,
		convert: (row) =>
			Effect.gen(function* () {
				const stored = yield* decode(Legacy.Delegation)(row.body)
				const value = stored.delegation
				const owner = {
					organizationId: stored.chain.organizationId,
					userId: stored.userId,
				}
				const namespace = yield* encode([owner.organizationId, owner.userId])
				yield* chatOf(namespace, value.parent.chat)
				if (value.parent.turn !== undefined)
					yield* turnExists(namespace, value.parent.chat, value.parent.turn)
				if (value.chat !== null) yield* chatOf(namespace, value.chat)
				if (
					row.id !== value.id ||
					row.organization_id !== owner.organizationId ||
					row.scope !== value.parent.chat ||
					row.owner !== owner.userId ||
					row.status !== value.status ||
					(stored.chain.owner ?? stored.chain.userId) !== owner.userId
				)
					return yield* invalid(
						"The delegation indexes do not match its record.",
					)
				const pending =
					value.status !== "completed" &&
					value.status !== "failed" &&
					value.status !== "cancelled"
				const key = yield* write({
					namespace,
					collection: "delegation",
					sourceKey: row.key,
					resource: { kind: "Delegation", id: value.id },
					context: { kind: "Chat", id: value.parent.chat },
					owner,
					history: yield* parse(row.body),
					reason: pending ? "OriginalCallerMissing" : "History",
					status: pending
						? "interrupted"
						: value.status === "failed"
							? "failed"
							: value.status === "cancelled"
								? "cancelled"
								: "completed",
					createdAt: value.createdAt,
					updatedAt: pending ? at : value.updatedAt,
				})
				const { runningSince: _runningSince, ...next } = stored
				yield* sql`update openbot_bot_records set body = ${yield* encode({ ...next, executionId: key.id })} where kind = 'delegation' and organization_id = ${row.organization_id} and id = ${row.id}`
				yield* progress.record(
					"delegation",
					row.key,
					pending ? "needs_authorization" : "converted",
					{ ...key, delegation: value.id },
				)
			}),
	})
	return yield* sql<{
		collection: string
		rows: number
	}>`select collection, count(*)::float8 as rows from openbot_data_upgrade_records where version = ${Progress.version} and collection in ('chat-item', 'turn', 'chat', 'chat-input', 'tool', 'request', 'delegation') group by collection order by collection`
})

/** Read every converted source again. A cursor only says what was written before. */
export const verify = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const secrets = yield* Secrets
	const progress = yield* Progress.make
	const [upgrade] = yield* sql<{
		started_at: string
	}>`select started_at from openbot_data_upgrades where version = ${Progress.version}`
	if (upgrade === undefined)
		return yield* invalid("The data move has no start record.")
	const at = Number(upgrade.started_at)
	const same = (actual: Schema.Json, expected: Schema.Json) =>
		Schema.toEquivalence(Schema.Json)(actual, expected)
	const proof = (collection: string, key: string) =>
		Effect.gen(function* () {
			const [row] = yield* sql<{
				body: string
			}>`select body from openbot_data_upgrade_records where version = ${Progress.version} and collection = ${collection} and key = ${key}`
			if (row === undefined)
				return yield* invalid("A Chat record has no data move proof.")
			return yield* secrets
				.open(
					row.body,
					yield* encode(["data-upgrade", Progress.version, collection, key]),
				)
				.pipe(Effect.flatMap(parse))
		})
	const history = (
		collection: string,
		sourceKey: string,
		namespace: string,
		resource: { readonly kind: string; readonly id: string },
	) =>
		Effect.gen(function* () {
			const link = yield* Schema.decodeUnknownEffect(
				Schema.Struct({ namespace: Schema.String, id: Schema.String }),
			)(yield* proof(collection, sourceKey))
			if (link.namespace !== namespace)
				return yield* invalid("A Chat history link names another namespace.")
			const [row] = yield* sql<{
				input: string
				resource_kind: string
				resource_id: string
				workflow: string
			}>`select input, resource_kind, resource_id, workflow from openbot_executions where namespace = ${namespace} and id = ${link.id}`
			if (
				row === undefined ||
				row.workflow !== Imported.workflowName ||
				row.resource_kind !== resource.kind ||
				row.resource_id !== resource.id
			)
				return yield* invalid("A Chat history link names another resource.")
			const input = yield* secrets
				.open(
					row.input,
					yield* encode(["execution", namespace, link.id, "input"]),
				)
				.pipe(
					Effect.flatMap(
						Schema.decodeEffect(Schema.fromJsonString(Imported.Input)),
					),
				)
			const owner = yield* ownerOf(namespace)
			if (!same(input.owner, owner))
				return yield* invalid("A Chat history link names another owner.")
			return { link, input }
		})
	yield* progress.verify({
		name: "verify:chat-items",
		read: (cursor, limit) =>
			sql<{
				key: string
				value: string
				id: string
				seq: number
				namespace: string
				chat: string
				turn: string | null
			}>`select json_build_array(namespace, chat, seq)::text as key, namespace, chat, turn, id, seq, value from openbot_chat_items where (${cursor}::text is null or json_build_array(namespace, chat, seq)::text > ${cursor}) order by json_build_array(namespace, chat, seq)::text limit ${limit}`,
		key: (row) => row.key,
		check: (row) =>
			Effect.gen(function* () {
				const item = yield* decode(Legacy.Item)(row.value)
				yield* Schema.decodeEffect(Item.Entry.fields.content)(item.content)
				const saved = yield* Schema.decodeUnknownEffect(
					Schema.Struct({ value: Schema.Json }),
				)(yield* proof("chat-item", row.key))
				if (
					!same(saved.value, yield* parse(row.value)) ||
					item.id !== row.id ||
					item.seq !== row.seq ||
					(item.origin?.turn ?? null) !== row.turn ||
					(item.origin !== undefined && item.origin.chat !== row.chat)
				)
					return yield* invalid(
						"A saved Chat Item changed during the data move.",
					)
				const [parent] =
					yield* sql`select id from openbot_chats where namespace = ${row.namespace} and id = ${row.chat}`
				if (parent === undefined)
					return yield* invalid("A saved Item has no Chat.")
			}),
	})
	yield* progress.verify({
		name: "verify:chat-turns",
		read: (cursor, limit) =>
			sql<{
				key: string
				value: string
				id: string
				namespace: string
				chat: string
			}>`select json_build_array(namespace, chat, id)::text as key, namespace, chat, id, value from openbot_chat_turns where (${cursor}::text is null or json_build_array(namespace, chat, id)::text > ${cursor}) order by json_build_array(namespace, chat, id)::text limit ${limit}`,
		key: (row) => row.key,
		check: (row) =>
			Effect.gen(function* () {
				const saved = yield* history("turn", row.key, row.namespace, {
					kind: "Turn",
					id: row.id,
				})
				const old = yield* Schema.decodeUnknownEffect(Legacy.Turn)(
					saved.input.history,
				)
				if (
					old.id !== row.id ||
					old.chat !== row.chat ||
					!same(stoppedTurn(old, at), yield* parse(row.value))
				)
					return yield* invalid("A saved Turn changed during the data move.")
			}),
	})
	yield* progress.verify({
		name: "verify:chats",
		read: (cursor, limit) =>
			sql<{
				key: string
				namespace: string
				id: string
				body: string
				state: string
				status: string
				turn: string | null
				inbox_size: number
				revision: number
				bot: string
				kind: string
				runner_seen_at: string | null
			}>`select json_build_array(namespace, id)::text as key, namespace, id, body, state, status, turn, inbox_size, revision, bot, kind, runner_seen_at from openbot_chats where (${cursor}::text is null or json_build_array(namespace, id)::text > ${cursor}) order by json_build_array(namespace, id)::text limit ${limit}`,
		key: (row) => row.key,
		check: (row) =>
			Effect.gen(function* () {
				const saved = yield* history("chat", row.key, row.namespace, {
					kind: "Chat",
					id: row.id,
				})
				const old = yield* Schema.decodeUnknownEffect(
					Schema.Struct({ chat: Legacy.Chat, state: Legacy.State }),
				)(saved.input.history)
				const host = yield* Schema.decodeUnknownEffect(Legacy.Host)(
					old.chat.business[Legacy.hostKey],
				)
				const next = {
					...old.chat,
					inbox: [],
					...(old.chat.turn === undefined
						? {}
						: { turn: stoppedTurn(old.chat.turn, at) }),
				}
				const state = yield* finishState(old.state)
				if (
					!same(next, yield* parse(row.body)) ||
					!same(state, yield* parse(row.state)) ||
					row.inbox_size !== 0 ||
					row.turn !== (next.turn?.id ?? null) ||
					row.status !== (next.turn?.status._tag ?? "Idle") ||
					row.revision !== next.revision ||
					row.bot !== host.bot ||
					row.kind !== host.kind ||
					row.runner_seen_at !== null
				)
					return yield* invalid("A saved Chat changed during the data move.")
				const [items] = yield* sql<{
					count: number
					last: number | null
				}>`select count(*)::float8 as count, max(seq) as last from openbot_chat_items where namespace = ${row.namespace} and chat = ${row.id}`
				if (items?.count !== next.seq || (items.last ?? 0) !== next.seq)
					return yield* invalid("The moved Chat has a missing Item.")
				for (const entry of old.chat.inbox) {
					const input = yield* history(
						"chat-input",
						yield* encode([row.namespace, row.id, entry.id]),
						row.namespace,
						{ kind: "ChatInput", id: entry.id },
					)
					if (!same(entry, input.input.history))
						return yield* invalid(
							"A queued input changed during the data move.",
						)
				}
			}),
	})
	yield* progress.verify({
		name: "verify:chat-tools",
		read: (cursor, limit) =>
			sql<{
				key: string
				namespace: string
				id: string
				chat: string
				status: string
				body: string
			}>`select json_build_array(namespace, id)::text as key, namespace, id, chat, status, body from openbot_operations where (${cursor}::text is null or json_build_array(namespace, id)::text > ${cursor}) order by json_build_array(namespace, id)::text limit ${limit}`,
		key: (row) => row.key,
		check: (row) =>
			Effect.gen(function* () {
				const saved = yield* history("tool", row.key, row.namespace, {
					kind: "ToolCall",
					id: row.id,
				})
				const old = yield* Schema.decodeUnknownEffect(Legacy.Operation)(
					saved.input.history,
				)
				const next =
					old.status._tag === "Running"
						? { ...old, status: { _tag: "Interrupted" }, endedAt: at }
						: old
				if (
					!same(next, yield* parse(row.body)) ||
					old.id !== row.id ||
					old.chat !== row.chat ||
					next.status._tag !== row.status
				)
					return yield* invalid(
						"A saved tool record changed during the data move.",
					)
			}),
	})
	for (const kind of ["request", "delegation"] as const) {
		yield* progress.verify({
			name: `verify:chat-${kind}`,
			read: (cursor, limit) =>
				sql<{
					key: string
					organization_id: string
					id: string
					body: string
					owner: string
					scope: string
					status: string
				}>`select json_build_array(organization_id, id)::text as key, organization_id, id, body, owner, scope, status from openbot_bot_records where kind = ${kind} and (${cursor}::text is null or json_build_array(organization_id, id)::text > ${cursor}) order by json_build_array(organization_id, id)::text limit ${limit}`,
			key: (row) => row.key,
			check: (row) =>
				Effect.gen(function* () {
					const link = yield* Schema.decodeUnknownEffect(
						Schema.Struct({ namespace: Schema.String }),
					)(yield* proof(kind, row.key))
					const saved = yield* history(kind, row.key, link.namespace, {
						kind: kind === "request" ? "Request" : "Delegation",
						id: row.id,
					})
					if (saved.input.owner.organizationId !== row.organization_id)
						return yield* invalid("A moved Bot record has another owner.")
					if (kind === "request") {
						const old = yield* Schema.decodeUnknownEffect(Legacy.Request)(
							saved.input.history,
						)
						const decider =
							old.request.approver._tag === "Person"
								? "person:" + old.request.approver.userId
								: "bot:" + old.request.approver.bot
						if (
							!same(old, yield* parse(row.body)) ||
							old.request.id !== row.id ||
							old.request.chat !== row.scope ||
							old.request.status !== row.status ||
							decider !== row.owner
						)
							return yield* invalid(
								"A saved request changed during the data move.",
							)
					} else {
						const old = yield* Schema.decodeUnknownEffect(Legacy.Delegation)(
							saved.input.history,
						)
						const { runningSince: _runningSince, ...value } = old
						if (
							!same(
								{ ...value, executionId: saved.link.id },
								yield* parse(row.body),
							) ||
							old.delegation.id !== row.id ||
							old.delegation.parent.chat !== row.scope ||
							old.delegation.status !== row.status ||
							old.userId !== row.owner
						)
							return yield* invalid(
								"A saved delegation changed during the data move.",
							)
					}
				}),
		})
	}
})
export const check = verify
