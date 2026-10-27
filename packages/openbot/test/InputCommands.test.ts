import * as ToolDefinitions from "../src/chats/ToolDefinitions.ts"
import { Delegations } from "../src/bots/Delegations.ts"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import {
	ChatStoreRepository,
	ChatState,
	Item,
	ToolStep,
	Store as CoreStore,
	Turn,
	TurnState,
} from "@openbot-build/core"
import {
	Execution,
	restrictExecution,
	type ExecutionIdentity,
} from "@openbot-build/domain"
import {
	Array as Arr,
	Deferred,
	Fiber,
	Schedule,
	Effect,
	Layer,
	Option,
	Redacted,
	String as Str,
} from "effect"
import { Prompt, Response } from "effect/ai"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Store from "../src/execution/Store.ts"
import { TurnAccess } from "../src/chats/TurnAccess.ts"
import { stepId } from "../src/chats/ToolSteps.ts"
import * as InputCommands from "../src/chats/InputCommands.ts"
import * as ChatHost from "../src/chats/ChatHost.ts"
import * as StoredChats from "../src/chats/StoredChats.ts"
import * as BotFixture from "./BotFixture.ts"
import * as PostgresTest from "./PostgresTest.ts"

const database = Layer.effectDiscard(DatabasePostgres.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (db) =>
				DatabasePostgres.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
)
const services = InputCommands.layer.pipe(
	Layer.provide(Layer.mock(Delegations, {})),
	Layer.provide(
		Layer.mock(TurnAccess, {
			admit: () => Effect.void,
			input: () => Effect.void,
		}),
	),
	Layer.provideMerge(Store.layer),
	Layer.provide(Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11")))),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeServices.layer),
)
const setup = Effect.fn(function* (namespace: string) {
	const db = yield* Db.make
	const definition = yield* CoreStore.define({
		stores: { [ChatHost.chatHostId]: ChatHost.chatHostStore },
		schemaVersion: "chat/1",
	})
	const chats = yield* ChatStoreRepository.make({
		definition,
		persistence: StoredChats.persistence(db, namespace),
	})
	const { bot, kind, chain } = BotFixture.direct()
	const view = yield* chats.create({
		business: { [ChatHost.chatHostId]: { bot: bot.id, kind, chain } },
	})
	const identity = ChatHost.identityOf(view.chat)
	const commands = yield* InputCommands.InputCommands
	const executions = yield* Store.Store
	const send = (
		key: string,
		actor: ExecutionIdentity = identity,
		queue = false,
	) =>
		commands.submit(namespace, Execution.CommandKey.make(key), {
			chat: view.chat.id,
			identity: actor,
			content: Prompt.make(key),
			queue,
		})
	return {
		namespace,
		chat: view.chat.id,
		chats,
		commands,
		executions,
		identity,
		send,
	}
})

layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	it.effect(
		"queued host actions keep their own Turn and saved tool definition",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("queued-host-action")
				const first = yield* test.send("first")
				const action = {
					name: "saved_tool",
					arguments: { text: "confirmed" },
					source: { view: "view" },
				}
				const actionDefinition = {
					name: action.name,
					parameters: { type: "object" },
					readOnly: false,
					local: true,
					idempotent: false,
					inputState: { revision: 1 },
				}
				const input = {
					chat: test.chat,
					identity: test.identity,
					content: Prompt.make("Host action"),
					queue: true,
					action,
					actionDefinition,
				}
				const submit = test.commands.submit(
					test.namespace,
					Execution.CommandKey.make("action"),
					input,
				)
				const receipt = yield* submit
				assert.deepEqual(yield* submit, receipt)
				const later = yield* test.send("later", test.identity, true)
				assert.notEqual(receipt.executionId, later.executionId)
				assert.notEqual(first.executionId, receipt.executionId)
				const key = { namespace: test.namespace, id: receipt.executionId }
				assert.deepEqual((yield* test.executions.load(key)).input, {
					chat: test.chat,
					host: ChatHost.hostState((yield* test.chats.read(test.chat)).chat),
					actionDefinition,
				})
				const firstKey = { namespace: test.namespace, id: first.executionId }
				yield* test.commands.finish(
					yield* test.executions.takeOver(firstKey),
					test.chat,
					{
						status: "interrupted",
						failure: {
							errorId: Execution.ErrorId.make("stopped"),
							category: "interrupted",
						},
					},
				)
				const view = yield* test.chats.read(test.chat)
				assert.deepEqual(view.chat.turn?.action, action)
				assert.equal(view.chat.turn?.input.length, 1)
				assert.equal(view.chat.inbox.length, 1)
				assert.equal((yield* test.executions.get(key)).status, "queued")
				assert.ok(view.chat.turn)
				const position = {
					chat: test.chat,
					turn: view.chat.turn.id,
					item: view.chat.turn.input[0]!,
					step: 0,
				}
				assert.deepEqual(
					Option.getOrThrow(
						yield* ToolDefinitions.selected(
							test.executions,
							key,
							position,
							action.name,
						),
					),
					actionDefinition,
				)
				assert.isTrue(
					Option.isNone(
						yield* ToolDefinitions.selected(
							test.executions,
							key,
							position,
							"changed_tool",
						),
					),
				)
			}),
	)

	it.effect("retries and concurrent input admit one Turn", () =>
		Effect.gen(function* () {
			const test = yield* setup("chat-command-retry")
			const receipts = yield* Effect.all(
				Arr.replicate(test.send("first"), 20),
				{ concurrency: "unbounded" },
			)
			const first = Arr.headNonEmpty(receipts)
			for (const receipt of receipts) assert.deepStrictEqual(receipt, first)
			const before = yield* test.chats.read(test.chat)
			assert.strictEqual(before.chat.turn?.input.length, 1)
			assert.strictEqual(before.chat.inbox.length, 0)
			const more = yield* Effect.forEach(
				Arr.range(1, 20),
				(n) => test.send("steer-" + n),
				{ concurrency: "unbounded" },
			)
			for (const receipt of more)
				assert.strictEqual(receipt.executionId, first.executionId)
			const view = yield* test.chats.read(test.chat)
			assert.strictEqual(view.chat.turn?.id, before.chat.turn?.id)
			assert.strictEqual(view.chat.inbox.length, 20)
			assert.isTrue(
				Arr.every(
					view.chat.inbox,
					(entry) =>
						entry.kind === "steer" && entry.author === view.chat.turn?.id,
				),
			)
			const sql = yield* PgClient.PgClient
			assert.strictEqual(
				(yield* sql`select * from openbot_executions where namespace = ${test.namespace}`)
					.length,
				1,
			)
			assert.strictEqual(
				(yield* sql`select * from openbot_execution_outbox where namespace = ${test.namespace}`)
					.length,
				1,
			)
		}),
	)

	it.effect(
		"queued input groups keep their identity and wait for resource release",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("chat-command-queue")
				const first = yield* test.send("first")
				const other = {
					...test.identity,
					actor: { ...test.identity.actor, userId: "other-user" },
				}
				const next = yield* test.send("next", other)
				const same = yield* test.send("same", other)
				const back = yield* test.send("back", test.identity, true)
				const last = yield* test.send("last", other)
				assert.strictEqual(next.executionId, same.executionId)
				assert.notStrictEqual(next.executionId, back.executionId)
				assert.notStrictEqual(next.executionId, last.executionId)
				const before = yield* test.chats.read(test.chat)
				assert.strictEqual(before.chat.inbox.length, 4)
				const sql = yield* PgClient.PgClient
				assert.strictEqual(
					(yield* sql`select * from openbot_execution_outbox where namespace = ${test.namespace}`)
						.length,
					1,
				)
				const key = { namespace: test.namespace, id: first.executionId }
				const fence = yield* test.executions.takeOver(key)
				yield* test.chats.modifyEffect({
					chat: test.chat,
					update: (view) => {
						const turn = view.chat.turn
						if (turn === undefined) return Effect.die("The Turn must exist.")
						return Effect.succeed([
							undefined,
							Option.some({
								chat: {
									turn: {
										...turn,
										status: Turn.Status.Completed({
											result: { text: "done", finishReason: "stop" },
										}),
									},
								},
							}),
						] as const)
					},
				})
				assert.isTrue(
					Option.isNone(yield* test.commands.drain(test.namespace, test.chat)),
				)
				assert.deepStrictEqual(
					yield* test.commands.finish(fence, test.chat, {
						status: "completed",
					}),
					Option.some(next.executionId),
				)
				assert.isTrue(
					Option.isNone(yield* test.commands.drain(test.namespace, test.chat)),
				)
				const view = yield* test.chats.read(test.chat)
				assert.strictEqual(view.chat.turn?.input.length, 2)
				assert.strictEqual(view.chat.inbox.length, 2)
				assert.strictEqual(
					(yield* sql`select * from openbot_execution_outbox where namespace = ${test.namespace}`)
						.length,
					2,
				)
				assert.deepStrictEqual(
					(yield* test.executions.load({
						namespace: test.namespace,
						id: next.executionId,
					})).identity,
					other,
				)
			}),
	)

	for (const kind of ["direct", "task"] as const)
		it.effect(
			`unread steering keeps its place and limits in a ${kind} Chat`,
			() =>
				Effect.gen(function* () {
					const test = yield* setup("chat-command-unread-" + kind)
					const first = yield* test.send("first")
					const other = {
						...test.identity,
						actor: { ...test.identity.actor, userId: "other-user" },
					}
					const before = yield* test.send("before", other)
					yield* test.send("steer")
					const after = yield* test.send("after", other)
					assert.notStrictEqual(before.executionId, after.executionId)
					const key = { namespace: test.namespace, id: first.executionId }
					const fence = yield* test.executions.takeOver(key)
					yield* test.chats.modifyEffect({
						chat: test.chat,
						update: (view) => {
							const turn = view.chat.turn
							if (turn === undefined) return Effect.die("The Turn must exist.")
							return Effect.succeed([
								undefined,
								Option.some({
									chat: {
										...(kind === "task"
											? {
													business: {
														...view.chat.business,
														[ChatHost.chatHostId]: {
															...ChatHost.hostState(view.chat),
															kind,
															inputConstraints: [other.actor],
														},
													},
												}
											: {}),
										turn: {
											...turn,
											status: Turn.Status.Completed({
												result: { text: "done", finishReason: "length" },
											}),
										},
										inbox: TurnState.after(view.chat.inbox, turn.id),
									},
								}),
							] as const)
						},
					})
					assert.deepStrictEqual(
						yield* test.commands.finish(fence, test.chat, {
							status: "completed",
						}),
						Option.some(before.executionId),
					)
					assert.isTrue(
						Option.isNone(
							yield* test.commands.finish(fence, test.chat, {
								status: "completed",
							}),
						),
					)
					const view = yield* test.chats.read(test.chat)
					assert.strictEqual(view.chat.turn?.input.length, 1)
					assert.strictEqual(view.chat.inbox.length, 2)
					assert.isDefined(view.chat.inbox[0]?.turn)
					const moved = Arr.flatMap(
						yield* test.executions.events(key, 0),
						(event) => (event.body._tag === "InputMoved" ? [event.body] : []),
					)
					assert.strictEqual(moved.length, 1)
					const notice = Arr.head(moved).pipe(Option.getOrThrow)
					const continuation = yield* test.executions.load({
						namespace: test.namespace,
						id: notice.executionId,
					})
					assert.strictEqual(continuation.record.status, "queued")
					assert.deepStrictEqual(
						continuation.identity,
						kind === "task"
							? restrictExecution(test.identity, [other.actor])
							: test.identity,
					)
					assert.strictEqual(
						continuation.record.resource.id,
						view.chat.inbox[0]?.turn,
					)
				}),
		)

	for (const status of ["failed", "interrupted"] as const)
		it.effect(
			`a ${status} Turn records its end and admits the next input once`,
			() =>
				Effect.gen(function* () {
					const test = yield* setup("chat-command-end-" + status)
					const first = yield* test.send("first")
					const next = yield* test.send("next", test.identity, true)
					const key = { namespace: test.namespace, id: first.executionId }
					const fence = yield* test.executions.takeOver(key)
					const failure = {
						category: "interrupted" as const,
						errorId: Execution.ErrorId.make("error-test"),
					}
					assert.deepEqual(
						yield* test.commands.finish(fence, test.chat, { status, failure }),
						Option.some(next.executionId),
					)
					assert.isTrue(
						Option.isNone(
							yield* test.commands.finish(fence, test.chat, {
								status,
								failure,
							}),
						),
					)
					const ended = yield* test.executions.get(key)
					assert.equal(ended.status, status)
					assert.deepEqual(ended.failure, failure)
					const history = yield* test.chats.turn(
						test.chat,
						Turn.Id.make(ended.resource.id),
					)
					assert.equal(
						Option.getOrThrow(history).status._tag,
						status === "failed" ? "Failed" : "Interrupted",
					)
					const view = yield* test.chats.read(test.chat)
					const nextRecord = yield* test.executions.get({
						namespace: test.namespace,
						id: next.executionId,
					})
					assert.equal(view.chat.turn?.id, nextRecord.resource.id)
					assert.equal(view.chat.turn?.status._tag, "Running")
					const events = yield* test.executions.events(key, 0)
					assert.equal(
						Arr.filter(events, (event) => event.body._tag === "Result").length,
						1,
					)
				}),
		)
	for (const savedIn of ["checkpoint", "call log"] as const)
		it.effect(
			`an ended Turn keeps a tool result from its ${savedIn} and marks an unknown result`,
			() =>
				Effect.gen(function* () {
					const test = yield* setup("chat-command-partial-" + savedIn)
					const first = yield* test.send("first")
					const key = { namespace: test.namespace, id: first.executionId }
					const fence = yield* test.executions.takeOver(key)
					const item = Item.Id.make("pending-item")
					const calls = [
						{ id: "known", name: "Write", params: {} },
						{ id: "unknown", name: "Write", params: {} },
					]
					const result = {
						id: "known",
						name: "Write",
						result: "The note was saved",
						isFailure: false,
						preliminary: false,
					}
					yield* test.chats.modifyEffect({
						chat: test.chat,
						update: (view) => {
							const turn = view.chat.turn
							if (turn === undefined) return Effect.die("The Turn must exist")
							return Effect.succeed([
								undefined,
								Option.some({
									chat: {
										turn: {
											...turn,
											pendingStep: {
												item,
												step: 1,
												input: Prompt.make("first"),
												before: Prompt.empty,
												model: {
													calls,
													finishReason: "tool-calls",
													output: Prompt.make([
														{
															role: "assistant",
															content: Arr.map(calls, (call) =>
																Prompt.toolCallPart({
																	...call,
																	providerExecuted: false,
																}),
															),
														},
													]),
													usage: Response.Usage.make({
														inputTokens: {
															total: 1,
															uncached: 1,
															cacheRead: undefined,
															cacheWrite: undefined,
														},
														outputTokens: {
															total: 1,
															text: 1,
															reasoning: undefined,
														},
													}),
												},
												after:
													savedIn === "checkpoint"
														? Prompt.make([
																{
																	role: "tool",
																	content: [
																		Prompt.toolResultPart({
																			...result,
																			providerExecuted: false,
																		}),
																	],
																},
															])
														: Prompt.empty,
											},
										},
									},
								}),
							] as const)
						},
					})
					const known = yield* test.executions.writeAttempt(
						fence,
						stepId(item, "known"),
						{},
					)
					yield* test.executions.sending(fence, known.id)
					yield* test.executions.finishCall(fence, known.id, result)
					const unknown = yield* test.executions.writeAttempt(
						fence,
						stepId(item, "unknown"),
						{},
					)
					yield* test.executions.sending(fence, unknown.id)
					yield* test.executions.uncertain(fence, unknown.id)
					yield* test.commands.finish(fence, test.chat, {
						status: "interrupted",
						failure: {
							category: "outcome_unknown",
							errorId: Execution.ErrorId.make("unknown-error"),
						},
					})
					const history = yield* test.chats.items(test.chat)
					const prompt = ChatState.promptOf(history)
					assert.equal(ToolStep.pending(prompt).length, 0)
					const results = Arr.flatMap(prompt.content, (message) =>
						message.role === "tool"
							? Arr.filter(
									message.content,
									(part) => part.type === "tool-result",
								)
							: [],
					)
					assert.equal(results.length, 2)
					assert.equal(results[0]?.result, "The note was saved")
					assert.deepEqual(results[1]?.result, {
						outcome: "unknown",
						errorId: "unknown-error",
						message:
							"The outside result is unknown. Check it before any new write.",
					})
					assert.isUndefined(
						(yield* test.chats.read(test.chat)).chat.turn?.pendingStep,
					)
				}),
		)
	it.effect(
		"a release failure keeps the completed Turn result and admits the next input",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("chat-command-release-failure")
				const first = yield* test.send("first")
				const next = yield* test.send("next", test.identity, true)
				const key = { namespace: test.namespace, id: first.executionId }
				const fence = yield* test.executions.takeOver(key)
				yield* test.chats.modifyEffect({
					chat: test.chat,
					update: (view) => {
						const turn = view.chat.turn
						if (turn === undefined) return Effect.die("The Turn must exist")
						return TurnState.end(view, {
							turn: turn.id,
							completedAt: 1,
							items: [],
							status: Turn.Status.Completed({
								result: { text: "done", finishReason: "stop" },
							}),
						}).pipe(
							Effect.map(
								({ mutation }) => [undefined, Option.some(mutation)] as const,
							),
						)
					},
				})
				yield* test.commands.finish(fence, test.chat, {
					status: "failed",
					failure: {
						category: "unavailable",
						errorId: Execution.ErrorId.make("release-error"),
					},
				})
				const ended = yield* test.executions.get(key)
				assert.equal(ended.status, "failed")
				assert.deepEqual(
					Option.getOrThrow(
						yield* test.chats.turn(test.chat, Turn.Id.make(ended.resource.id)),
					).status,
					Turn.Status.Completed({
						result: { text: "done", finishReason: "stop" },
					}),
				)
				assert.equal(
					(yield* test.chats.read(test.chat)).chat.turn?.id,
					(yield* test.executions.get({
						namespace: test.namespace,
						id: next.executionId,
					})).resource.id,
				)
			}),
	)
	it.effect(
		"a late result waits for the Turn end transaction after its call snapshot",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("chat-command-end-lock")
				const first = yield* test.send("first")
				const key = { namespace: test.namespace, id: first.executionId }
				const fence = yield* test.executions.takeOver(key)
				const call = yield* test.executions.writeAttempt(fence, "write", {})
				yield* test.executions.sending(fence, call.id)
				yield* test.executions.uncertain(fence, call.id)
				const read = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const commands = yield* InputCommands.InputCommands.pipe(
					Effect.provide(
						Layer.fresh(
							InputCommands.layer.pipe(
								Layer.provide(Layer.mock(Delegations, {})),
							),
						).pipe(
							Layer.provide(
								Layer.succeed(Store.Store, {
									...test.executions,
									calls: (key) =>
										test.executions
											.calls(key)
											.pipe(
												Effect.tap(() =>
													Deferred.succeed(read, undefined).pipe(
														Effect.andThen(Deferred.await(release)),
													),
												),
											),
								}),
							),
							Layer.provide(
								Layer.mock(TurnAccess, {
									admit: () => Effect.void,
									input: () => Effect.void,
								}),
							),
						),
					),
				)
				const finishing = yield* commands
					.finish(fence, test.chat, {
						status: "interrupted",
						failure: {
							category: "outcome_unknown",
							errorId: Execution.ErrorId.make("late-error"),
						},
					})
					.pipe(Effect.forkScoped)
				yield* Effect.raceFirst(
					Deferred.await(read),
					Fiber.join(finishing).pipe(
						Effect.andThen(Effect.die("The Turn ended before reading calls")),
					),
				)
				const sql = yield* PgClient.PgClient
				const late = yield* sql
					.withTransaction(
						Effect.gen(function* () {
							yield* sql`select set_config('application_name', ${test.namespace}, true)`
							return yield* test.executions.finishCall(
								fence,
								call.id,
								"late result",
							)
						}),
					)
					.pipe(Effect.forkScoped)
				yield* sql`select pid from pg_stat_activity where application_name = ${test.namespace} and wait_event_type = 'Lock'`.pipe(
					Effect.repeat({
						schedule: Schedule.spaced("10 millis"),
						until: (rows) => rows.length > 0,
					}),
					Effect.timeout("5 seconds"),
					Effect.ensuring(Deferred.succeed(release, undefined)),
				)
				yield* Fiber.join(finishing)
				assert.isFalse(yield* Fiber.join(late))
				assert.equal(
					(yield* test.executions.calls(fence))[0]?.result,
					"late result",
				)
				assert.equal((yield* test.executions.get(key)).status, "interrupted")
			}),
	)
	it.effect(
		"cancel completion ends the Turn and admits input in one transaction",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("chat-cancel-finish")
				const first = yield* test.send("first")
				const next = yield* test.send("next", test.identity, true)
				const key = { namespace: test.namespace, id: first.executionId }
				const fence = yield* test.executions.takeOver(key)
				yield* test.executions.cancel(
					key,
					Execution.CommandKey.make("stop"),
					test.identity.actor,
				)
				const before = yield* test.chats.read(test.chat)
				const sql = yield* PgClient.PgClient
				yield* sql`create function fail_cancel_event() returns trigger language plpgsql as $$ begin if NEW.namespace = 'chat-cancel-finish' then raise exception 'event write failed'; end if; return NEW; end; $$`
				yield* sql`create trigger fail_cancel_event before insert on openbot_execution_events for each row execute function fail_cancel_event()`
				yield* test.commands
					.finish(fence, test.chat, { status: "cancelled", epoch: 1 })
					.pipe(Effect.flip)
				assert.deepStrictEqual(yield* test.chats.read(test.chat), before)
				assert.equal((yield* test.executions.get(key)).status, "cancelling")
				yield* sql`drop trigger fail_cancel_event on openbot_execution_events`
				assert.deepStrictEqual(
					yield* test.commands.finish(fence, test.chat, {
						status: "cancelled",
						epoch: 1,
					}),
					Option.some(next.executionId),
				)
				const view = yield* test.chats.read(test.chat)
				assert.equal(
					view.chat.turn?.id,
					(yield* test.executions.get({ ...key, id: next.executionId }))
						.resource.id,
				)
				const ended = yield* test.chats.turn(
					test.chat,
					Turn.Id.make((yield* test.executions.get(key)).resource.id),
				)
				assert.equal(Option.getOrUndefined(ended)?.status._tag, "Interrupted")
				assert.equal((yield* test.executions.get(key)).status, "cancelled")
				assert.isTrue(
					Option.isNone(
						yield* test.commands.finish(fence, test.chat, {
							status: "cancelled",
							epoch: 1,
						}),
					),
				)
				assert.equal(
					Arr.filter(
						yield* test.executions.events(key, 0),
						(event) => event.body._tag === "Result",
					).length,
					1,
				)
			}),
	)
	it.effect(
		"cancelled queued work and unknown writes keep the right queue order",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("chat-cancel-unknown")
				const first = yield* test.send("first")
				const removed = yield* test.send(
					"removed",
					{
						...test.identity,
						actor: { ...test.identity.actor, userId: "other" },
					},
					true,
				)
				const next = yield* test.send("next", test.identity, true)
				const key = { namespace: test.namespace, id: first.executionId }
				const fence = yield* test.executions.takeOver(key)
				const queued = { ...key, id: removed.executionId }
				yield* test.executions.cancel(
					queued,
					Execution.CommandKey.make("stop-queued"),
					test.identity.actor,
				)
				const queuedFence = yield* test.executions.takeOver(queued)
				yield* test.commands.finish(queuedFence, test.chat, {
					status: "cancelled",
					epoch: 1,
				})
				assert.equal((yield* test.chats.read(test.chat)).chat.inbox.length, 1)
				assert.equal((yield* test.executions.get(queued)).status, "cancelled")
				const call = yield* test.executions.writeAttempt(fence, "write", null)
				yield* test.executions.sending(fence, call.id)
				yield* test.executions.cancel(
					key,
					Execution.CommandKey.make("stop"),
					test.identity.actor,
				)
				assert.isTrue(
					Option.isNone(
						yield* test.commands.finish(fence, test.chat, {
							status: "cancelled",
							epoch: 1,
						}),
					),
				)
				assert.equal(
					(yield* test.executions.get(key)).status,
					"outcome_unknown",
				)
				assert.equal(
					(yield* test.executions.get({ ...key, id: next.executionId })).status,
					"queued",
				)
				assert.equal(
					(yield* test.chats.read(test.chat)).chat.turn?.status._tag,
					"Running",
				)
			}),
	)

	for (const action of ["complete", "drain", "submit"] as const) {
		it.effect(`cancelled queued input does not block ${action}`, () =>
			Effect.gen(function* () {
				const test = yield* setup("chat-command-cancel-" + action)
				const first = yield* test.send("first")
				const other = {
					...test.identity,
					actor: { ...test.identity.actor, userId: "other-user" },
				}
				const removed = yield* test.send("removed", other)
				const next = yield* test.send("next", test.identity, true)
				const key = { namespace: test.namespace, id: first.executionId }
				const fence = yield* test.executions.takeOver(key)
				yield* test.chats.modifyEffect({
					chat: test.chat,
					update: (view) => {
						const turn = view.chat.turn
						if (turn === undefined) return Effect.die("The Turn must exist.")
						return Effect.succeed([
							undefined,
							Option.some({
								chat: {
									turn: {
										...turn,
										status: Turn.Status.Completed({
											result: { text: "done", finishReason: "stop" },
										}),
									},
								},
							}),
						] as const)
					},
				})
				const cancelled = { namespace: test.namespace, id: removed.executionId }
				yield* test.executions.cancel(
					cancelled,
					Execution.CommandKey.make("cancel"),
					other.actor,
				)
				if (action !== "complete") {
					// Completing A must wait at the cancelling input while its resources close.
					assert.isTrue(
						Option.isNone(
							yield* test.commands.finish(fence, test.chat, {
								status: "completed",
							}),
						),
					)
					assert.strictEqual(
						(yield* test.chats.read(test.chat)).chat.inbox.length,
						2,
					)
				}
				yield* test.executions.finishCancellation(
					yield* test.executions.takeOver(cancelled),
					(yield* test.executions.load(cancelled)).cancelEpoch,
				)
				if (action === "complete")
					assert.deepStrictEqual(
						yield* test.commands.finish(fence, test.chat, {
							status: "completed",
						}),
						Option.some(next.executionId),
					)
				else if (action === "drain")
					assert.deepStrictEqual(
						yield* test.commands.drain(test.namespace, test.chat),
						Option.some(next.executionId),
					)
				else yield* test.send("after", other)
				const view = yield* test.chats.read(test.chat)
				const loaded = yield* test.executions.load({
					namespace: test.namespace,
					id: next.executionId,
				})
				assert.strictEqual(view.chat.turn?.id, loaded.record.resource.id)
				assert.strictEqual(view.chat.turn?.input.length, 1)
				assert.strictEqual(view.chat.inbox.length, action === "submit" ? 1 : 0)
				assert.strictEqual(
					(yield* test.executions.get(key)).status,
					"completed",
				)
				assert.strictEqual(
					(yield* test.executions.get(cancelled)).status,
					"cancelled",
				)
				const sql = yield* PgClient.PgClient
				assert.strictEqual(
					(yield* sql`select * from openbot_execution_outbox where namespace = ${test.namespace} and execution_id = ${next.executionId}`)
						.length,
					1,
				)
			}),
		)
	}

	it.effect("an event failure rolls back input and its execution", () =>
		Effect.gen(function* () {
			const test = yield* setup("chat-command-rollback")
			const before = yield* test.chats.read(test.chat)
			const sql = yield* PgClient.PgClient
			yield* sql`create function fail_input_event() returns trigger language plpgsql as $$ begin if NEW.namespace = 'chat-command-rollback' and NEW.sequence > 1 then raise exception 'event write failed'; end if; return NEW; end; $$`
			yield* sql`create trigger fail_input_event before insert on openbot_execution_events for each row execute function fail_input_event()`
			yield* test.send("first").pipe(Effect.flip)
			assert.deepStrictEqual(yield* test.chats.read(test.chat), before)
			assert.strictEqual(
				(yield* sql`select * from openbot_executions where namespace = ${test.namespace}`)
					.length,
				0,
			)
			assert.strictEqual(
				(yield* sql`select * from openbot_execution_commands where namespace = ${test.namespace}`)
					.length,
				0,
			)
			yield* sql`drop trigger fail_input_event on openbot_execution_events`
			yield* sql`drop function fail_input_event()`
			yield* test.send("first")
			assert.strictEqual(
				(yield* test.chats.read(test.chat)).chat.turn?.status._tag,
				"Running",
			)
		}),
	)
})
