import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, it } from "@effect/vitest"
import { Chat, ChatState, Item } from "@openbot-build/core"
import {
	Authorization,
	Execution,
	TokenId,
	ToolExecution,
	Delegations as DelegationDomain,
	type Caller,
} from "@openbot-build/domain"
import { Authorizer, Policy } from "@nmnmcc/ability"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import {
	Array as Arr,
	HashMap,
	Option,
	Ref,
	Effect,
	Layer,
	Redacted,
	Schema,
	String as Str,
} from "effect"
import { Prompt } from "effect/ai"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import * as Migrations from "../src/database/Migrations.ts"
import * as Chats from "../src/database/conversion/Chats.ts"
import * as Imported from "../src/database/conversion/Executions.ts"
import * as Legacy from "../src/database/conversion/LegacyChats.ts"
import * as Progress from "../src/database/conversion/Progress.ts"
import * as Store from "../src/execution/Store.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as ImportedWorkflow from "../src/database/conversion/ImportedWorkflow.ts"
import * as Inputs from "../src/chats/InputCommands.ts"
import { TurnAccess } from "../src/chats/TurnAccess.ts"
import * as ToolQueries from "../src/chats/ToolQueries.ts"
import { ToolCommands } from "../src/chats/ToolCommands.ts"
import { ModelRegistry } from "../src/models/ModelRegistry.ts"
import * as OpenWork from "../src/chats/OpenWork.ts"
import * as ChatWork from "../src/bots/ChatWork.ts"
import { Reminders } from "../src/plugins/work/Reminders.ts"
import * as Delegations from "../src/bots/Delegations.ts"
import * as BotRecords from "../src/bots/BotRecords.ts"
import * as DelegationQueries from "../src/bots/DelegationQueries.ts"
import { DelegationCommands } from "../src/bots/DelegationCommands.ts"
import { Bots } from "../src/bots/Bots.ts"
import { Commands } from "../src/execution/Commands.ts"
import * as Requests from "../src/capabilities/Requests.ts"
import { RequestCommands } from "../src/capabilities/RequestCommands.ts"
import * as Resolve from "../src/capabilities/Resolve.ts"
import * as MigrationTest from "./MigrationTest.ts"
import * as PostgresTest from "./PostgresTest.ts"

const database = () =>
	Store.layer.pipe(
		Layer.provideMerge(
			Layer.unwrap(
				Effect.map(PostgresTest.start, (database) =>
					Layer.merge(
						DatabasePostgres.layer({
							databaseUrl: Redacted.make(database.url),
						}),
						Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
					),
				),
			),
		),
		Layer.provideMerge(NodeServices.layer),
	)
const json = Schema.fromJsonString(Schema.Json)
const encode = Schema.encodeEffect(json)
const namespace = '["org","person"]'
const chain = {
	organizationId: "org",
	userId: "person",
	bots: ["bot"],
	chats: [],
}
const host = { bot: "bot", kind: "direct", chain }
const before = Effect.gen(function* () {
	const db = yield* Db.make
	const folder = yield* MigrationTest.migrationsWhere(
		(name) => name < "20261026084803_execution_records",
	)
	yield* migrate(db, { migrationsFolder: folder })
})
const turn = (id: string) => ({
	id,
	chat: "chat",
	settings: { mode: "build" },
	status: {
		_tag: "Completed",
		result: { text: "saved answer", finishReason: "stop" },
	},
	steps: 0,
	input: [],
	items: [],
	startedAt: 1,
	completedAt: 2,
})
const saveChat = (
	current: Schema.Json,
	seq = 0,
	inbox: ReadonlyArray<Schema.Json> = [],
) =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient
		const value = yield* Schema.decodeUnknownEffect(Legacy.Turn)(current)
		const body = {
			id: "chat",
			revision: 7,
			settings: { mode: "build" },
			inbox,
			turn: current,
			seq,
			business: { [Legacy.hostKey]: host },
			createdAt: 1,
		}
		const prompt = yield* Schema.encodeEffect(Item.Entry.fields.content)(
			Prompt.empty,
		)
		yield* sql`insert into openbot_chats ${sql.insert({ namespace, id: "chat", body: yield* encode(body), state: yield* encode({ conversation: { context: { _tag: "Prompt", prompt }, closed: value.status._tag !== "Running" }, privatePlugin: { note: "private state" } }), bot: "bot", kind: "direct", status: value.status._tag, turn: value.id, revision: 7, inbox_size: inbox.length, created_at: 1, updated_at: 2 })}`
	})
const saveTurn = (value: Schema.Json) =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient
		const record = yield* Schema.decodeUnknownEffect(Legacy.Turn)(value)
		yield* sql`insert into openbot_chat_turns ${sql.insert({ namespace, chat: "chat", id: record.id, value: yield* encode(value) })}`
	})

it.layer(database(), { excludeTestServices: true })((it) => {
	it.effect(
		"old Chats keep history and pending decisions without sending old work",
		() =>
			Effect.gen(function* () {
				yield* before
				const sql = yield* PgClient.PgClient
				const store = yield* Store.Store
				const secrets = yield* Secrets.Secrets
				const content = yield* Schema.encodeEffect(Item.Entry.fields.content)(
					Prompt.make([
						{
							role: "assistant",
							content: [
								Prompt.toolCallPart({
									id: "outside",
									name: "write",
									params: { value: "private write" },
									providerExecuted: false,
								}),
								Prompt.toolCallPart({
									id: "wait",
									name: "allowed_later",
									params: {},
									providerExecuted: false,
								}),
								Prompt.toolApprovalRequestPart({
									approvalId: "approval",
									toolCallId: "wait",
								}),
							],
						},
					]),
				)
				const current = {
					id: "turn",
					chat: "chat",
					settings: { mode: "build" },
					status: { _tag: "Running" },
					steps: 0,
					input: [],
					items: ["item"],
					startedAt: 1,
				}
				const input = {
					id: "queued",
					content: yield* Schema.encodeEffect(Item.Entry.fields.content)(
						Prompt.make([{ role: "user", content: "private queued input" }]),
					),
					kind: "message",
				}
				yield* saveChat(current, 1, [input])
				yield* sql`update openbot_chats set state = ${yield* encode({ conversation: { context: { _tag: "Prompt", prompt: content }, closed: false }, privatePlugin: { note: "private state" } })} where id = 'chat'`
				yield* saveTurn(current)
				yield* saveTurn(turn("old-turn"))
				const item = {
					id: "item",
					seq: 1,
					content,
					origin: { chat: "chat", turn: "turn", step: 0 },
				}
				yield* sql`insert into openbot_chat_items ${sql.insert({ namespace, chat: "chat", seq: 1, id: "item", turn: "turn", value: yield* encode(item) })}`
				const request = {
					request: {
						id: "approval",
						bot: "bot",
						capability: { action: "tools.call", target: "allowed_later" },
						reason: "Please allow the call.",
						approver: { _tag: "Person", userId: "person" },
						chain: ["bot"],
						chat: "chat",
						turn: "turn",
						toolCallId: "wait",
						endorsements: [],
						status: "pending",
						decision: null,
						revision: 0,
						createdAt: 1,
						expiresAt: 9999999999999,
					},
					chain,
					call: {
						name: "allowed_later",
						params: { value: "private approval" },
					},
				}
				yield* sql`insert into openbot_bot_records ${sql.insert({ kind: "request", organization_id: "org", id: "approval", owner: "person:person", scope: "chat", status: "pending", body: yield* encode(request) })}`
				const delegation = {
					delegation: {
						id: "work",
						parent: { chat: "chat", turn: "turn", toolCallId: "delegated" },
						bot: "bot",
						chat: null,
						status: "running",
						task: "private task",
						result: null,
						createdAt: 1,
						updatedAt: 2,
					},
					userId: "person",
					author: "person",
					chain,
					runningSince: 1,
				}
				yield* sql`insert into openbot_bot_records ${sql.insert({ kind: "delegation", organization_id: "org", id: "work", owner: "person", scope: "chat", status: "running", body: yield* encode(delegation) })}`
				const tool = {
					id: "tool",
					chat: "chat",
					turn: "turn",
					callId: "outside",
					tool: "write",
					kind: "tool",
					status: { _tag: "Running" },
					startedAt: 1,
				}
				yield* sql`insert into openbot_operations ${sql.insert({ namespace, id: "tool", chat: "chat", status: "Running", body: yield* encode(tool), started_at: 1, heartbeat_at: 1 })}`
				const doneTool = {
					...tool,
					id: "done-tool",
					callId: "done-call",
					status: {
						_tag: "Completed",
						result: { value: "private tool result" },
					},
					endedAt: 2,
				}
				yield* sql`insert into openbot_operations ${sql.insert({ namespace, id: doneTool.id, chat: "chat", status: "Completed", body: yield* encode(doneTool), started_at: 1, heartbeat_at: 2 })}`
				yield* Migrations.initialize
				const counts = yield* Progress.withMaintenance(Chats.run)
				yield* Chats.verify
				assert.deepStrictEqual(counts, [
					{ collection: "chat", rows: 1 },
					{ collection: "chat-input", rows: 1 },
					{ collection: "chat-item", rows: 1 },
					{ collection: "delegation", rows: 1 },
					{ collection: "request", rows: 1 },
					{ collection: "tool", rows: 2 },
					{ collection: "turn", rows: 2 },
				])
				const rows = yield* sql<{
					id: string
					resource_kind: string
					resource_id: string
					status: string
					input: string
				}>`select id, resource_kind, resource_id, status, input from openbot_executions order by resource_kind, resource_id`
				assert.strictEqual(rows.length, 8)
				const running = Arr.findFirst(
					rows,
					(row) => row.resource_kind === "Turn" && row.resource_id === "turn",
				)
				assert.strictEqual(running._tag, "Some")
				if (running._tag !== "Some")
					return yield* Effect.die("Expected the imported Turn.")
				assert.strictEqual(running.value.status, "outcome_unknown")
				const key = { namespace, id: Execution.Id.make(running.value.id) }
				const calls = yield* store.calls(key)
				assert.strictEqual(calls.length, 1)
				assert.include(calls[0]?.step ?? "", "outside")
				assert.strictEqual(calls[0]?.status, "outcome_unknown")
				const done = Arr.findFirst(
					rows,
					(row) =>
						row.resource_kind === "ToolCall" && row.resource_id === "done-tool",
				)
				if (done._tag !== "Some")
					return yield* Effect.die("Expected the completed tool.")
				const doneCalls = yield* store.calls({
					namespace,
					id: Execution.Id.make(done.value.id),
				})
				assert.strictEqual(done.value.status, "completed")
				assert.deepStrictEqual(doneCalls[0]?.result, {
					value: "private tool result",
				})
				const saved = yield* store.loadService(key, Imported.serviceId)
				const imported = yield* Schema.decodeUnknownEffect(Imported.Input)(
					saved.input,
				)
				assert.strictEqual(imported.authority._tag, "NeedsAuthorization")
				assert.strictEqual(saved.identity.owner.kind, "organization")
				const [chat] = yield* sql<{
					body: string
					status: string
					inbox_size: number
				}>`select body, status, inbox_size from openbot_chats where id = 'chat'`
				if (chat === undefined)
					return yield* Effect.die("Expected the saved Chat.")
				const chatValue = yield* Schema.decodeEffect(
					Schema.fromJsonString(Legacy.Chat),
				)(chat.body)
				assert.strictEqual(chat.status, "Interrupted")
				assert.strictEqual(chat.inbox_size, 0)
				assert.strictEqual(chatValue.turn?.id, "turn")
				assert.deepStrictEqual(chatValue.business, { [Legacy.hostKey]: host })
				const [keptRequest] = yield* sql<{
					body: string
					status: string
				}>`select body, status from openbot_bot_records where kind = 'request'`
				assert.strictEqual(keptRequest?.body, yield* encode(request))
				assert.strictEqual(keptRequest?.status, "pending")
				const [keptItem] = yield* sql<{
					value: string
				}>`select value from openbot_chat_items`
				assert.strictEqual(keptItem?.value, yield* encode(item))
				const queued = Arr.findFirst(
					rows,
					(row) => row.resource_kind === "ChatInput",
				)
				if (queued._tag !== "Some")
					return yield* Effect.die("Expected the saved input.")
				assert.notInclude(queued.value.input, "private queued input")
				const opened = yield* secrets.open(
					queued.value.input,
					yield* encode(["execution", namespace, queued.value.id, "input"]),
				)
				assert.include(opened, "private queued input")
				assert.deepStrictEqual(
					yield* Progress.withMaintenance(Chats.run),
					counts,
				)
				const [total] = yield* sql<{
					count: number
				}>`select count(*)::float8 as count from openbot_executions`
				assert.strictEqual(total?.count, 8)
				const [outbox] = yield* sql<{
					count: number
				}>`select count(*)::float8 as count from openbot_execution_outbox`
				assert.strictEqual(outbox?.count, 0)
				yield* Chats.verify
				const [state] = yield* sql<{
					state: string
				}>`select state from openbot_chats where id = 'chat'`
				if (state === undefined)
					return yield* Effect.die("Expected the moved conversation.")
				const moved = yield* Schema.decodeEffect(
					Schema.fromJsonString(Legacy.State),
				)(state.state)
				assert.strictEqual(
					HashMap.size(
						ChatState.pendingCalls(
							yield* Schema.decodeEffect(Item.Entry.fields.content)(
								moved.conversation.context.prompt,
							),
						),
					),
					0,
				)
				yield* sql`update openbot_chat_items set value = ${yield* encode({ ...item, content: { content: [] } })} where id = 'item'`
				assert.isTrue(
					Schema.is(Progress.InvalidRecord)(
						yield* Chats.verify.pipe(Effect.flip),
					),
				)
				yield* sql`update openbot_chat_items set value = ${yield* encode(item)} where id = 'item'`
				yield* Chats.verify
				yield* sql`update openbot_executions set input = 'broken sealed history' where namespace = ${namespace} and id = ${key.id}`
				assert.isTrue(
					Schema.is(Progress.InvalidRecord)(
						yield* Chats.verify.pipe(Effect.flip),
					),
				)
				yield* sql`update openbot_executions set input = ${running.value.input} where namespace = ${namespace} and id = ${key.id}`
				yield* Chats.verify
				const allowed = yield* Ref.make(true)
				const actor: Caller = {
					kind: "user_token",
					organizationId: "org",
					userId: "person",
					tokenId: TokenId.make("fresh-token"),
				}
				const policy = Policy.define(Authorization.OpenBot)(function* (_) {
					yield* _.allow("read", Authorization.Chat)
					yield* _.allow("write", Authorization.Chat)
					yield* _.allow("resolve", Authorization.Request)
				})
				const auth = Authorizer.layer(Authorization.Auth, {
					policy: (caller) =>
						Ref.get(allowed).pipe(
							Effect.map((enabled) =>
								enabled &&
								caller.organizationId === "org" &&
								caller.userId === "person"
									? policy
									: Authorization.emptyPolicy,
							),
						),
				})
				const runtime = Inputs.layer.pipe(
					Layer.provideMerge(
						Layer.mergeAll(
							Layer.mock(TurnAccess, {
								command: () => Effect.void,
								input: () => Effect.void,
								admit: () => Effect.void,
							}),
							Layer.mock(ModelRegistry, { defaultModel: Option.none() }),
							OpenWork.layerNone,
							Layer.mock(Bots, {}),
							Layer.mock(ToolCommands, { list: () => Effect.succeed([]) }),
							Layer.mock(DelegationCommands, {}),
							Layer.mock(Commands, {}),
							Layer.mock(RequestCommands, {}),
							Layer.mock(Reminders, { forChat: () => Effect.succeed([]) }),
							Delegations.layer.pipe(Layer.provide(BotRecords.layer)),
							Layer.mock(Requests.Requests, {
								forChat: (organizationId, chat) =>
									sql<{
										body: string
									}>`select body from openbot_bot_records where kind = 'request' and organization_id = ${organizationId} and scope = ${chat}`.pipe(
										Effect.flatMap(
											Effect.forEach((row) =>
												Schema.decodeEffect(
													Schema.fromJsonString(Requests.Stored),
												)(row.body),
											),
										),
										Effect.orDie,
									),
								find: (organizationId, id) =>
									sql<{
										body: string
									}>`select body from openbot_bot_records where kind = 'request' and organization_id = ${organizationId} and id = ${id}`.pipe(
										Effect.flatMap((rows) =>
											rows[0] === undefined
												? Effect.succeedNone
												: Schema.decodeEffect(
														Schema.fromJsonString(Requests.Stored),
													)(rows[0].body).pipe(Effect.asSome),
										),
										Effect.orDie,
									),
							}),
						),
					),
					Layer.provideMerge(auth),
				)
				yield* Effect.gen(function* () {
					const tools = yield* ToolQueries.make
					const delegations = yield* DelegationQueries.make
					const approvals = yield* Resolve.make
					const inputs = yield* Inputs.InputCommands
					const currentWork = yield* ChatWork.make
					assert.deepStrictEqual(
						yield* currentWork.read("org", Chat.Id.make("chat")),
						{
							delegations: [],
							requests: [],
							reminders: [],
						},
					)
					const history = yield* tools.list(actor, Chat.Id.make("chat"))
					assert.strictEqual(history.length, 2)
					assert.deepStrictEqual(
						(yield* tools.read(
							actor,
							Chat.Id.make("chat"),
							ToolExecution.Id.make("done-tool"),
						)).output,
						{ value: "private tool result" },
					)
					const work = yield* delegations.read(
						actor,
						DelegationDomain.DelegationId.make("work"),
					)
					assert.strictEqual(work.executionStatus, "interrupted")
					assert.strictEqual(work.task, "private task")
					const approval = yield* approvals.view(actor, "approval")
					assert.strictEqual(approval.status, "pending")
					assert.strictEqual(approval.executionStatus, "interrupted")
					assert.strictEqual(
						(yield* approvals.list(actor, "pending")).length,
						1,
					)
					const rejected = yield* approvals
						.resolveAsPerson(actor, "approval", {
							commandKey: Execution.CommandKey.make("old-approval"),
							expected: 0,
							decision: "allow",
						})
						.pipe(Effect.flip)
					assert.strictEqual(rejected._tag, "RequestConflict")
					const send = () =>
						inputs.message(
							namespace,
							Execution.CommandKey.make("fresh-input"),
							{
								chat: Chat.Id.make("chat"),
								caller: actor,
								content: Prompt.make("New work"),
								queue: false,
							},
						)
					assert.strictEqual(
						(yield* send().pipe(Effect.flip))._tag,
						"ChatConflict",
					)
					const [queued] = yield* sql<{
						inbox_size: number
					}>`select inbox_size from openbot_chats where id = 'chat'`
					assert.strictEqual(queued?.inbox_size, 0)
					const importedCommands = yield* ImportedWorkflow.make
					const firstCall = calls[0]
					if (firstCall === undefined)
						return yield* Effect.die("Expected an unknown old call.")
					yield* importedCommands.decide(key, actor, {
						commandKey: Execution.CommandKey.make("stop-old-call"),
						decisionId: firstCall.id,
						answer: "stop",
					})
					const receipt = yield* send()
					const fresh = yield* store.loadMember({
						namespace,
						id: receipt.executionId,
					})
					assert.deepStrictEqual(fresh.identity.actor, actor)
					assert.notStrictEqual(receipt.executionId, key.id)
					assert.strictEqual(fresh.workflow, Inputs.workflowName)
					yield* Ref.set(allowed, false)
					assert.strictEqual(
						(yield* tools
							.read(
								actor,
								Chat.Id.make("chat"),
								ToolExecution.Id.make("done-tool"),
							)
							.pipe(Effect.flip))._tag,
						"Forbidden",
					)
					assert.strictEqual(
						(yield* delegations
							.read(actor, DelegationDomain.DelegationId.make("work"))
							.pipe(Effect.flip))._tag,
						"ExecutionForbidden",
					)
					assert.strictEqual(
						(yield* approvals.view(actor, "approval").pipe(Effect.flip))._tag,
						"ExecutionForbidden",
					)
				}).pipe(Effect.provide(runtime))
			}),
		30_000,
	)
})

it.layer(database(), { excludeTestServices: true })((it) => {
	it.effect(
		"a broken Turn rolls back one batch and a repair resumes after the saved cursor",
		() =>
			Effect.gen(function* () {
				yield* before
				const sql = yield* PgClient.PgClient
				yield* saveChat(turn("100"))
				for (let index = 0; index <= 100; index++) {
					const id = Str.padStart(3, "0")(String(index))
					yield* sql`insert into openbot_chat_turns ${sql.insert({ namespace, chat: "chat", id, value: index === 100 ? "private broken Turn" : yield* encode(turn(id)) })}`
				}
				yield* Migrations.initialize
				const failure = yield* Effect.flip(Progress.withMaintenance(Chats.run))
				assert.isTrue(Schema.is(Progress.InvalidRecord)(failure))
				const [step] = yield* sql<{
					rows: string
					complete: boolean
				}>`select rows, complete from openbot_data_upgrade_steps where step = 'chat-turns'`
				assert.strictEqual(Number(step?.rows), 100)
				assert.strictEqual(step?.complete, false)
				const [total] = yield* sql<{
					count: number
				}>`select count(*)::float8 as count from openbot_executions`
				assert.strictEqual(total?.count, 100)
				const [kept] = yield* sql<{
					input: string
				}>`select input from openbot_executions where resource_id = '000'`
				yield* sql`update openbot_chat_turns set value = ${yield* encode(turn("wrong-id"))} where id = '100'`
				const wrongId = yield* Effect.flip(Progress.withMaintenance(Chats.run))
				assert.isTrue(Schema.is(Progress.InvalidRecord)(wrongId))
				const [unchanged] = yield* sql<{
					count: number
				}>`select count(*)::float8 as count from openbot_executions`
				assert.strictEqual(unchanged?.count, 100)
				yield* sql`update openbot_chat_turns set value = ${yield* encode(turn("100"))} where id = '100'`
				yield* Progress.withMaintenance(Chats.run)
				yield* Progress.withMaintenance(Chats.run)
				const [after] = yield* sql<{
					input: string
				}>`select input from openbot_executions where resource_id = '000'`
				assert.strictEqual(after?.input, kept?.input)
				const [done] = yield* sql<{
					rows: string
					complete: boolean
				}>`select rows, complete from openbot_data_upgrade_steps where step = 'chat-turns'`
				assert.strictEqual(Number(done?.rows), 101)
				assert.strictEqual(done?.complete, true)
				const [finished] = yield* sql<{
					count: number
				}>`select count(*)::float8 as count from openbot_executions`
				assert.strictEqual(finished?.count, 102)
			}),
		30_000,
	)
})
