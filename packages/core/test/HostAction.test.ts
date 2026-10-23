// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import {
	Chat,
	ChatRuntime,
	ChatStoreRepository,
	MemoryPersistence,
	Store,
} from "@openbot-build/core"
import { Array as EffectArray, Deferred, Effect, Match, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { settled } from "./ChatTest.ts"

const setup = Effect.gen(function* () {
	const definition = yield* Store.define({
		stores: {},
		schemaVersion: "host-action/1",
	})
	return yield* ChatStoreRepository.make({
		definition,
		persistence: yield* MemoryPersistence.make,
	})
})
const approvalRequests = (view: Chat.View<{}>) =>
	view.state.conversation.context.prompt.content.flatMap((message) =>
		Match.value(message).pipe(
			Match.when({ role: "assistant" }, (message) =>
				message.content.filter((part) => part.type === "tool-approval-request"),
			),
			Match.orElse(() => []),
		),
	)

test("a host action checks the exact parameters without the model, and runs only when a decider allows it", async () => {
	let calls: ReadonlyArray<string> = []
	let decisions: ReadonlyArray<Chat.ApprovalRequest> = []
	const write = Tool.make("Write", {
		parameters: Schema.Struct({ text: Schema.String }),
		success: Schema.String,
		needsApproval: true,
	})
	const toolkit = Toolkit.make(write)
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const store = yield* setup
				const runtime = yield* ChatRuntime.make({
					store,
					bot: {
						toolkit,
						modelCatalog: Effect.die(
							"Host actions must not load a model catalog",
						),
					},
				})
				const chat = (yield* store.create({})).chat.id
				const receipt = yield* runtime.startAction({
					chat,
					action: {
						name: "Write",
						arguments: { text: "Exact host selection" },
						source: { surface: "test" },
					},
				})
				assert.equal(receipt.callId, "host-action-" + receipt.turn)
				const pending = yield* settled(runtime, chat)
				const pendingTurn = Chat.currentTurn(pending.chat)!
				assert.equal(pendingTurn.id, receipt.turn)
				assert.equal(pendingTurn.status._tag, "Completed")
				assert.deepEqual(pendingTurn.action?.arguments, {
					text: "Exact host selection",
				})
				assert.equal(pendingTurn.usage?.length ?? 0, 0)
				assert.deepEqual(calls, [])
				const [request] = approvalRequests(pending)
				assert.ok(request)
				assert.equal(request.toolCallId, receipt.callId)
				// A new runtime over the same store has a decider, as after a restart.
				const restored = yield* ChatRuntime.make({
					store,
					bot: {
						toolkit,
						approvals: {
							decide: (request) =>
								Effect.sync(() => {
									decisions = EffectArray.append(decisions, request)
									return Chat.Decision.Allow()
								}),
						},
					},
				})
				const allowed = yield* restored.startAction({
					chat,
					action: {
						name: "Write",
						arguments: { text: "Exact host selection" },
					},
				})
				assert.notEqual(allowed.turn, receipt.turn)
				const completed = yield* settled(restored, chat)
				assert.equal(Chat.status(completed.chat)._tag, "Completed")
				assert.deepEqual(calls, ["Exact host selection"])
				assert.equal(decisions.length, 1)
				assert.equal(decisions[0]!.toolCall.id, allowed.callId)
				assert.deepEqual(decisions[0]!.toolCall.params, {
					text: "Exact host selection",
				})
				assert.match(
					JSON.stringify(yield* store.items(chat, { turn: allowed.turn })),
					/Actual receipt: Exact host selection/,
				)
				const invalid = yield* restored.startAction({
					chat,
					action: { name: "Write", arguments: { text: 17 } },
				})
				assert.notEqual(invalid.turn, allowed.turn)
				const after = yield* settled(restored, chat)
				assert.equal(Chat.currentTurn(after.chat)!.id, invalid.turn)
				assert.equal(Chat.status(after.chat)._tag, "Failed")
				assert.deepEqual(calls, ["Exact host selection"])
			}),
		).pipe(
			Effect.provide(
				toolkit.toLayer({
					Write: ({ text }) =>
						Effect.sync(() => {
							calls = [...calls, text]
							return "Actual receipt: " + text
						}),
				}),
			),
		),
	)
})

test("host actions share cancellation and admission, and other Chats keep running", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const released = yield* Deferred.make<void>()
				const gate = Tool.make("Gate", {
					parameters: Schema.Struct({ hold: Schema.Boolean }),
					success: Schema.String,
				})
				const toolkit = Toolkit.make(gate)
				const store = yield* setup
				const runtime = yield* ChatRuntime.make({ store, bot: { toolkit } })
				const first = (yield* store.create({})).chat.id
				const second = (yield* store.create({})).chat.id
				const handlers = yield* toolkit.toHandlers({
					Gate: ({ hold }) =>
						hold
							? Deferred.succeed(entered, undefined).pipe(
									Effect.andThen(Effect.never),
									Effect.ensuring(Deferred.succeed(released, undefined)),
								)
							: Effect.succeed("Independent receipt"),
				})
				const held = yield* runtime
					.startAction({
						chat: first,
						action: { name: "Gate", arguments: { hold: true } },
					})
					.pipe(Effect.provideContext(handlers))
				yield* Deferred.await(entered)
				const busy = yield* runtime
					.startAction({
						chat: first,
						action: { name: "Gate", arguments: { hold: false } },
					})
					.pipe(Effect.provideContext(handlers), Effect.flip)
				assert.equal(busy._tag, "ChatConflict")
				const other = yield* runtime
					.startAction({
						chat: second,
						action: { name: "Gate", arguments: { hold: false } },
					})
					.pipe(Effect.provideContext(handlers))
				assert.notEqual(held.turn, other.turn)
				const stopped = yield* runtime.interrupt({
					chat: held.chat,
					turn: held.turn,
				})
				yield* Deferred.await(released)
				assert.equal(Chat.status(stopped.chat)._tag, "Interrupted")
				const view = yield* settled(runtime, second)
				assert.equal(Chat.status(view.chat)._tag, "Completed")
				assert.match(
					JSON.stringify(yield* store.items(second)),
					/Independent receipt/,
				)
			}),
		),
	)
})

test("a related host action waits in the running Turn and keeps its own approval and Item", async () => {
	let writes = 0
	let decisions: ReadonlyArray<Chat.ApprovalRequest> = []
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const gate = Tool.make("Gate", { success: Schema.String })
				const write = Tool.make("Write", {
					parameters: Schema.Struct({ text: Schema.String }),
					success: Schema.String,
					needsApproval: true,
				})
				const toolkit = Toolkit.make(gate, write)
				const handlers = yield* toolkit.toHandlers({
					Gate: () =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
							Effect.as("Original receipt"),
						),
					Write: ({ text }) =>
						Effect.sync(() => {
							writes++
							return "Related receipt: " + text
						}),
				})
				const store = yield* setup
				const runtime = yield* ChatRuntime.make({
					store,
					bot: {
						toolkit,
						approvals: {
							decide: (request) =>
								Effect.sync(() => {
									decisions = EffectArray.append(decisions, request)
									return Chat.Decision.Allow()
								}),
						},
					},
				})
				const chat = (yield* store.create({})).chat.id
				const original = yield* runtime
					.startAction({ chat, action: { name: "Gate", arguments: {} } })
					.pipe(Effect.provideContext(handlers))
				yield* Deferred.await(entered)
				const related = yield* runtime
					.startAction({
						chat,
						turn: original.turn,
						action: {
							name: "Write",
							arguments: { text: "Specific selection" },
						},
					})
					.pipe(Effect.provideContext(handlers))
				assert.equal(related.turn, original.turn)
				assert.notEqual(related.item, original.item)
				assert.equal(related.callId, "host-action-" + related.item)
				const waiting = yield* store.read(chat)
				assert.deepEqual(
					waiting.chat.inbox.map((entry) => [entry.id, entry.kind, entry.turn]),
					[[related.item, "action", original.turn]],
				)
				assert.equal(writes, 0)
				yield* Deferred.succeed(release, undefined)
				const completed = yield* settled(runtime, chat)
				const turn = Chat.currentTurn(completed.chat)!
				assert.equal(turn.id, original.turn)
				assert.equal(turn.status._tag, "Completed")
				assert.equal(turn.activeAction, undefined)
				assert.ok(turn.items.includes(related.item))
				assert.equal(writes, 1)
				assert.equal(decisions.length, 1)
				assert.equal(decisions[0]!.turn, original.turn)
				assert.equal(decisions[0]!.toolCall.id, related.callId)
				const [request] = approvalRequests(completed).filter(
					(part) => part.toolCallId === related.callId,
				)
				assert.ok(request)
				const items = JSON.stringify(yield* store.items(chat))
				assert.match(items, /Original receipt/)
				assert.match(items, /Related receipt: Specific selection/)
			}),
		),
	)
})

test("a related host action needs the Turn to run in this runtime", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const toolkit = Toolkit.make(
					Tool.make("Gate", { success: Schema.String }),
				)
				const store = yield* setup
				const runtime = yield* ChatRuntime.make({ store, bot: { toolkit } })
				const chat = (yield* store.create({})).chat.id
				const done = yield* runtime
					.startAction({ chat, action: { name: "Gate", arguments: {} } })
					.pipe(
						Effect.provide(
							toolkit.toLayer({ Gate: () => Effect.succeed("done") }),
						),
					)
				yield* settled(runtime, chat)
				const late = yield* runtime
					.startAction({
						chat,
						turn: done.turn,
						action: { name: "Gate", arguments: {} },
					})
					.pipe(
						Effect.provide(
							toolkit.toLayer({ Gate: () => Effect.succeed("late") }),
						),
						Effect.flip,
					)
				assert.equal(late._tag, "TurnConflict")
			}),
		),
	)
})
