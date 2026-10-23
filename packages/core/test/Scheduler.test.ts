// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import { Array as EffectArray, Deferred, Effect, Option, Stream } from "effect"
import { AiError, Prompt } from "effect/ai"
import {
	Chat,
	ChatRuntime,
	Item as ChatItem,
	MemoryPersistence,
} from "@openbot-build/core"
import { ChatTest, settled } from "./ChatTest.ts"
import { LanguageModelTest, textParts } from "./LanguageModelTest.ts"

/** A model that holds its first request until `gate` opens. Later requests answer at once. */
const heldModel = (input: {
	readonly ready: Deferred.Deferred<void>
	readonly gate: Deferred.Deferred<void>
	readonly prompts: { value: ReadonlyArray<Prompt.Prompt> }
	readonly first?: Stream.Stream<never, AiError.AiError>
}) =>
	LanguageModelTest({
		streamText: ({ prompt }) => {
			input.prompts.value = EffectArray.append(input.prompts.value, prompt)
			return input.prompts.value.length === 1
				? Stream.fromEffect(
						Deferred.succeed(input.ready, undefined).pipe(
							Effect.andThen(Deferred.await(input.gate)),
						),
					).pipe(
						Stream.flatMap(() =>
							input.first === undefined
								? Stream.fromArray(textParts("first"))
								: input.first,
						),
					)
				: Stream.fromArray(textParts("done"))
		},
	})

test("deliver starts a Turn in an idle Chat, steers the Turn of the same author, and queues input from another author", async () => {
	const prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const ready = yield* Deferred.make<void>(),
					gate = yield* Deferred.make<void>()
				yield* Effect.gen(function* () {
					const { runtime, runtimeStore, chat } = yield* ChatTest()
					const started = yield* runtime.deliver({ chat, input: "initial" })
					assert.equal(started.delivery, "started")
					assert.ok(started.turn !== undefined)
					yield* Deferred.await(ready)
					const steered = yield* runtime.deliver({
						chat,
						input: "steering instruction",
					})
					assert.equal(steered.delivery, "steered")
					assert.equal(steered.turn, started.turn)
					const queued = yield* runtime.deliver({
						chat,
						input: "ordinary queued input",
						author: "bob",
					})
					assert.equal(queued.delivery, "queued")
					assert.equal(queued.turn, undefined)
					const waiting = yield* runtimeStore.read(chat)
					assert.deepEqual(
						waiting.chat.inbox.map((entry) => [entry.id, entry.kind]),
						[
							[steered.item, "steer"],
							[queued.item, "message"],
						],
					)
					yield* runtimeStore.modifyEffect({
						chat,
						update: (current) =>
							Effect.succeed([
								undefined,
								Option.some({
									chat: {
										settings: { ...current.chat.settings, mode: "plan" },
									},
								}),
							] as const),
					})
					yield* Deferred.succeed(gate, undefined)
					const done = yield* settled(runtime, chat)
					const first = Option.getOrThrow(
						yield* runtimeStore.turn(chat, started.turn),
					)
					assert.equal(first.status._tag, "Completed")
					assert.equal(first.steps, 2)
					assert.equal(first.settings.mode, "build")
					assert.deepEqual(first.input, [started.item])
					assert.ok(first.items.includes(steered.item))
					const next = Chat.currentTurn(done.chat)!
					assert.notEqual(next.id, first.id)
					assert.equal(next.author, "bob")
					assert.equal(next.settings.mode, "plan")
					assert.deepEqual(next.input, [queued.item])
					assert.deepEqual(done.chat.inbox, [])
					assert.equal((yield* runtimeStore.turns(chat)).length, 2)
					assert.match(JSON.stringify(prompts.value[1]), /steering instruction/)
					assert.doesNotMatch(
						JSON.stringify(prompts.value[1]),
						/ordinary queued input/,
					)
					assert.match(
						JSON.stringify(prompts.value.at(-1)),
						/ordinary queued input/,
					)
					const late = yield* runtime
						.interrupt({ chat, turn: started.turn })
						.pipe(Effect.flip)
					assert.equal(late._tag, "TurnConflict")
				}).pipe(Effect.provide(heldModel({ ready, gate, prompts })))
			}),
		),
	)
})

test("deliver with queue waits for the next Turn, also when a Turn of the same author runs", async () => {
	const prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const ready = yield* Deferred.make<void>(),
					gate = yield* Deferred.make<void>()
				yield* Effect.gen(function* () {
					const { runtime, runtimeStore, chat } = yield* ChatTest()
					const started = yield* runtime.deliver({
						chat,
						input: "from ada",
						author: "ada",
					})
					yield* Deferred.await(ready)
					const queued = yield* runtime.deliver({
						chat,
						input: "later from ada",
						author: "ada",
						queue: true,
					})
					assert.equal(queued.delivery, "queued")
					yield* Deferred.succeed(gate, undefined)
					const done = yield* settled(runtime, chat)
					const first = Option.getOrThrow(
						yield* runtimeStore.turn(chat, started.turn!),
					)
					assert.equal(first.steps, 1)
					assert.equal(first.items.includes(queued.item), false)
					const next = Chat.currentTurn(done.chat)!
					assert.equal(next.author, "ada")
					assert.deepEqual(next.input, [queued.item])
				}).pipe(Effect.provide(heldModel({ ready, gate, prompts })))
			}),
		),
	)
})

test("the next Turn starts from the inbox after a Turn fails", async () => {
	const prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const ready = yield* Deferred.make<void>(),
					gate = yield* Deferred.make<void>()
				const failure = AiError.make({
					module: "test",
					method: "streamText",
					reason: AiError.InternalProviderError.make({
						description: "the model broke",
					}),
				})
				yield* Effect.gen(function* () {
					const { runtime, runtimeStore, chat } = yield* ChatTest()
					const started = yield* runtime.deliver({
						chat,
						input: "from ada",
						author: "ada",
					})
					yield* Deferred.await(ready)
					const queued = yield* runtime.deliver({
						chat,
						input: "from bob",
						author: "bob",
					})
					assert.equal(queued.delivery, "queued")
					yield* Deferred.succeed(gate, undefined)
					const done = yield* settled(runtime, chat)
					const failed = Option.getOrThrow(
						yield* runtimeStore.turn(chat, started.turn!),
					)
					assert.equal(failed.status._tag, "Failed")
					assert.ok(failed.status._tag === "Failed")
					assert.equal(failed.status.code, "model_error")
					const next = Chat.currentTurn(done.chat)!
					assert.equal(next.author, "bob")
					assert.deepEqual(next.input, [queued.item])
					assert.equal(next.status._tag, "Completed")
				}).pipe(
					Effect.provide(
						heldModel({ ready, gate, prompts, first: Stream.fail(failure) }),
					),
				)
			}),
		),
	)
})

test("the next Turn starts from the inbox after a Turn is interrupted", async () => {
	const prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const ready = yield* Deferred.make<void>(),
					gate = yield* Deferred.make<void>()
				yield* Effect.gen(function* () {
					const { runtime, runtimeStore, chat } = yield* ChatTest()
					const started = yield* runtime.deliver({
						chat,
						input: "from ada",
						author: "ada",
					})
					yield* Deferred.await(ready)
					const queued = yield* runtime.deliver({
						chat,
						input: "from bob",
						author: "bob",
					})
					assert.equal(queued.delivery, "queued")
					yield* runtime.interrupt({ chat, turn: started.turn! })
					const done = yield* settled(runtime, chat)
					assert.equal(
						Option.getOrThrow(yield* runtimeStore.turn(chat, started.turn!))
							.status._tag,
						"Interrupted",
					)
					const next = Chat.currentTurn(done.chat)!
					assert.equal(next.author, "bob")
					assert.deepEqual(next.input, [queued.item])
					assert.equal(next.status._tag, "Completed")
					assert.equal(prompts.value.length, 2)
				}).pipe(Effect.provide(heldModel({ ready, gate, prompts })))
			}),
		),
	)
})

test("the next Turn reads the first run of messages from one author, and later messages wait for their own Turn", async () => {
	const prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const ready = yield* Deferred.make<void>(),
					gate = yield* Deferred.make<void>()
				yield* Effect.gen(function* () {
					const { runtime, runtimeStore, chat } = yield* ChatTest()
					yield* runtime.deliver({ chat, input: "from ada", author: "ada" })
					yield* Deferred.await(ready)
					const bob1 = yield* runtime.deliver({
						chat,
						input: "first from bob",
						author: "bob",
					})
					const bob2 = yield* runtime.deliver({
						chat,
						input: "second from bob",
						author: "bob",
					})
					const carol = yield* runtime.deliver({
						chat,
						input: "from carol",
						author: "carol",
					})
					assert.deepEqual(
						[bob1, bob2, carol].map((delivery) => delivery.delivery),
						["queued", "queued", "queued"],
					)
					yield* Deferred.succeed(gate, undefined)
					const done = yield* settled(runtime, chat)
					const turns = yield* runtimeStore.turns(chat)
					assert.deepEqual(
						turns.map((turn) => [turn.author, turn.input.length]),
						[
							["ada", 1],
							["bob", 2],
							["carol", 1],
						],
					)
					assert.deepEqual(turns[1]!.input, [bob1.item, bob2.item])
					assert.deepEqual(turns[2]!.input, [carol.item])
					assert.equal(Chat.currentTurn(done.chat)!.id, turns[2]!.id)
					assert.equal(prompts.value.length, 3)
				}).pipe(Effect.provide(heldModel({ ready, gate, prompts })))
			}),
		),
	)
})

test("two Chats run independently, and a Turn cannot start while another Turn runs", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const entered = [
						yield* Deferred.make<void>(),
						yield* Deferred.make<void>(),
					],
					release = yield* Deferred.make<void>()
				let requests = 0
				const model = LanguageModelTest({
					streamText: () => {
						const signal = entered[requests++]!
						return Stream.fromEffect(
							Deferred.succeed(signal, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
							),
						).pipe(Stream.flatMap(() => Stream.fromArray(textParts("done"))))
					},
				})
				yield* Effect.gen(function* () {
					const { runtime, runtimeStore, chat } = yield* ChatTest()
					const other = yield* runtimeStore.create({})
					const a = yield* runtime.deliver({ chat, input: "one" })
					yield* Deferred.await(entered[0]!)
					const b = yield* runtime.deliver({
						chat: other.chat.id,
						input: "two",
					})
					assert.equal(b.delivery, "started")
					assert.notEqual(a.turn, b.turn)
					yield* Deferred.await(entered[1]!)
					const collision = yield* runtime
						.execute({ chat, input: "collision" })
						.pipe(Effect.flip)
					assert.equal(collision._tag, "ChatConflict")
					const streamed = yield* runtime
						.stream({ chat, input: "collision" })
						.pipe(Stream.runDrain, Effect.flip)
					assert.equal(streamed._tag, "ChatConflict")
					const action = yield* runtime
						.startAction({
							chat,
							action: { name: "Missing", arguments: {} },
						})
						.pipe(Effect.flip)
					assert.equal(action._tag, "ChatConflict")
					assert.equal(requests, 2)
					yield* runtime.interrupt({ chat, turn: a.turn! })
					assert.equal(
						Chat.status((yield* runtimeStore.read(other.chat.id)).chat)._tag,
						"Running",
					)
					yield* Deferred.succeed(release, undefined)
					const done = yield* settled(runtime, other.chat.id)
					assert.equal(Chat.status(done.chat)._tag, "Completed")
				}).pipe(Effect.provide(model))
			}),
		),
	)
})

test(
	"closing the runtime while a Turn runs ends the Turn, keeps the waiting input in the inbox, and a new runtime can start it",
	{ timeout: 5000 },
	async () => {
		const prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const ready = yield* Deferred.make<void>(),
						gate = yield* Deferred.make<void>()
					const model = heldModel({ ready, gate, prompts })
					const persistence = yield* MemoryPersistence.make
					const first = yield* Effect.scoped(
						Effect.gen(function* () {
							const { runtime, chat } = yield* ChatTest({}, { persistence })
							const running = yield* runtime.deliver({
								chat,
								input: "from ada",
								author: "ada",
							})
							yield* Deferred.await(ready)
							const steered = yield* runtime.deliver({
								chat,
								input: "more from ada",
								author: "ada",
							})
							assert.equal(steered.delivery, "steered")
							const queued = yield* runtime.deliver({
								chat,
								input: "from bob",
								author: "bob",
							})
							assert.equal(queued.delivery, "queued")
							return { chat, running, steered, queued }
						}),
					).pipe(
						Effect.provide(model),
						Effect.timeoutOrElse({
							duration: "2 seconds",
							orElse: () => Effect.die("The runtime did not close"),
						}),
					)
					yield* Effect.gen(function* () {
						// A new runtime over the same persistence, as after a restart.
						const { runtime, runtimeStore } = yield* ChatTest(
							{},
							{ persistence },
						)
						const closed = yield* runtimeStore.read(first.chat)
						assert.equal(Chat.currentTurn(closed.chat)!.id, first.running.turn)
						assert.equal(Chat.status(closed.chat)._tag, "Interrupted")
						assert.deepEqual(
							closed.chat.inbox.map((entry) => [entry.id, entry.kind]),
							[
								[first.steered.item, "message"],
								[first.queued.item, "message"],
							],
						)
						assert.equal((yield* runtimeStore.turns(first.chat)).length, 1)
						const next = yield* runtime.drain(first.chat)
						assert.equal(next?.item, first.steered.item)
						yield* settled(runtime, first.chat)
						const turns = yield* runtimeStore.turns(first.chat)
						assert.deepEqual(
							turns.map((turn) => [turn.author, turn.status._tag]),
							[
								["ada", "Interrupted"],
								["ada", "Completed"],
								["bob", "Completed"],
							],
						)
					}).pipe(Effect.provide(model))
				}),
			),
		)
	},
)

test("drain starts a Turn for input that waits in an idle Chat, and does nothing when no input waits", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { runtime, runtimeStore, chat } = yield* ChatTest()
				assert.equal(yield* runtime.drain(chat), undefined)
				const waiting = ChatItem.Id.make("waiting")
				yield* runtimeStore.modifyEffect({
					chat,
					update: () =>
						Effect.succeed([
							undefined,
							Option.some({
								chat: {
									inbox: [
										{
											id: waiting,
											content: Prompt.make("saved before a restart"),
											kind: "message" as const,
											author: "ada",
										},
									],
								},
							}),
						] as const),
				})
				const delivery = yield* runtime.drain(chat)
				assert.ok(delivery !== undefined)
				assert.equal(delivery.delivery, "started")
				assert.equal(delivery.item, waiting)
				const done = yield* settled(runtime, chat)
				const turn = Chat.currentTurn(done.chat)!
				assert.equal(turn.id, delivery.turn)
				assert.equal(turn.author, "ada")
				assert.deepEqual(turn.input, [waiting])
				assert.equal(turn.status._tag, "Completed")
				assert.equal(yield* runtime.drain(chat), undefined)
			}),
		).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () => Stream.fromArray(textParts("done")),
				}),
			),
		),
	)
})

test("a new runtime does not restart a running Turn of the store; interrupt ends it, and drain starts the waiting input", async () => {
	const prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const ready = yield* Deferred.make<void>(),
					gate = yield* Deferred.make<void>()
				yield* Effect.gen(function* () {
					const { runtime, runtimeStore, chat } = yield* ChatTest()
					const running = yield* runtime.deliver({
						chat,
						input: "running",
						author: "ada",
					})
					yield* Deferred.await(ready)
					// The second runtime is like a host after a restart.
					const restored = yield* ChatRuntime.make({
						store: runtimeStore,
						bot: {},
					})
					assert.equal(yield* restored.isActive(chat), false)
					assert.equal(yield* restored.drain(chat), undefined)
					const queued = yield* restored.deliver({
						chat,
						input: "stay queued",
						author: "bob",
					})
					assert.equal(queued.delivery, "queued")
					assert.equal(prompts.value.length, 1)
					const stopped = yield* restored.interrupt({
						chat,
						turn: running.turn!,
					})
					assert.equal(Chat.status(stopped.chat)._tag, "Interrupted")
					assert.equal(stopped.chat.inbox.length, 1)
					const next = yield* restored.drain(chat)
					assert.ok(next !== undefined)
					assert.equal(next.item, queued.item)
					const done = yield* settled(restored, chat)
					assert.equal(Chat.currentTurn(done.chat)!.author, "bob")
					assert.equal(Chat.status(done.chat)._tag, "Completed")
					assert.equal(prompts.value.length, 2)
				}).pipe(Effect.provide(heldModel({ ready, gate, prompts })))
			}),
		),
	)
})
