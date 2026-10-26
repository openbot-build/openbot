import { assert, it } from "@effect/vitest"
import {
	Array as Arr,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Logger,
	Option,
	pipe,
	Scope,
	Stream,
} from "effect"
import { AiError, Prompt } from "effect/ai"
import {
	Chat,
	ChatRuntime,
	Item as ChatItem,
	MemoryPersistence,
} from "@openbot-build/core"
import { ChatTest, settled } from "./ChatTest.ts"
import { LanguageModelTest, textParts } from "./LanguageModelTest.ts"

/** All the text of a prompt: the system text and every text part, one on each line. */
const promptText = (prompt: Prompt.Prompt) =>
	pipe(
		prompt.content,
		Arr.flatMap((message): ReadonlyArray<string> => {
			if (message.role === "system") return [message.content]
			const parts: ReadonlyArray<Prompt.Part> = message.content
			return pipe(
				parts,
				Arr.filter((part) => part.type === "text"),
				Arr.map((part) => part.text),
			)
		}),
		Arr.join("\n"),
	)

/** A model that holds its first request until `gate` opens. Later requests answer at once. */
const heldModel = (input: {
	readonly ready: Deferred.Deferred<void>
	readonly gate: Deferred.Deferred<void>
	readonly prompts: { value: ReadonlyArray<Prompt.Prompt> }
	readonly first?: Stream.Stream<never, AiError.AiError>
}) =>
	LanguageModelTest({
		streamText: ({ prompt }) => {
			input.prompts.value = Arr.append(input.prompts.value, prompt)
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

it.effect(
	"deliver starts a Turn in an idle Chat, steers the Turn of the same author, and queues input from another author",
	() => {
		const prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
		return Effect.gen(function* () {
			const ready = yield* Deferred.make<void>(),
				gate = yield* Deferred.make<void>()
			yield* Effect.gen(function* () {
				const { runtime, runtimeStore, chat } = yield* ChatTest()
				const started = yield* runtime.deliver({ chat, input: "initial" })
				assert.strictEqual(started.delivery, "started")
				assert.ok(started.turn !== undefined)
				yield* Deferred.await(ready)
				const steered = yield* runtime.deliver({
					chat,
					input: "steering instruction",
				})
				assert.strictEqual(steered.delivery, "steered")
				assert.strictEqual(steered.turn, started.turn)
				const queued = yield* runtime.deliver({
					chat,
					input: "ordinary queued input",
					author: "bob",
				})
				assert.strictEqual(queued.delivery, "queued")
				assert.strictEqual(queued.turn, undefined)
				const waiting = yield* runtimeStore.read(chat)
				assert.deepStrictEqual(
					Arr.map(waiting.chat.inbox, (entry) => [entry.id, entry.kind]),
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
				assert.strictEqual(first.status._tag, "Completed")
				assert.strictEqual(first.steps, 2)
				assert.strictEqual(first.settings.mode, "build")
				assert.deepStrictEqual(first.input, [started.item])
				assert.ok(first.items.includes(steered.item))
				const next = Chat.currentTurn(done.chat)!
				assert.notStrictEqual(next.id, first.id)
				assert.strictEqual(next.author, "bob")
				assert.strictEqual(next.settings.mode, "plan")
				assert.deepStrictEqual(next.input, [queued.item])
				assert.deepStrictEqual(done.chat.inbox, [])
				assert.strictEqual((yield* runtimeStore.turns(chat)).length, 2)
				assert.match(promptText(prompts.value[1]!), /steering instruction/)
				assert.notMatch(promptText(prompts.value[1]!), /ordinary queued input/)
				assert.match(promptText(prompts.value.at(-1)!), /ordinary queued input/)
				const late = yield* runtime
					.interrupt({ chat, turn: started.turn })
					.pipe(Effect.flip)
				assert.strictEqual(late._tag, "TurnConflict")
			}).pipe(Effect.provide(heldModel({ ready, gate, prompts })))
		})
	},
)

it.effect(
	"deliver with queue waits for the next Turn, also when a Turn of the same author runs",
	() => {
		const prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
		return Effect.gen(function* () {
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
				assert.strictEqual(queued.delivery, "queued")
				yield* Deferred.succeed(gate, undefined)
				const done = yield* settled(runtime, chat)
				const first = Option.getOrThrow(
					yield* runtimeStore.turn(chat, started.turn!),
				)
				assert.strictEqual(first.steps, 1)
				assert.strictEqual(first.items.includes(queued.item), false)
				const next = Chat.currentTurn(done.chat)!
				assert.strictEqual(next.author, "ada")
				assert.deepStrictEqual(next.input, [queued.item])
			}).pipe(Effect.provide(heldModel({ ready, gate, prompts })))
		})
	},
)

it.effect("the next Turn starts from the inbox after a Turn fails", () => {
	const prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
	return Effect.gen(function* () {
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
			assert.strictEqual(queued.delivery, "queued")
			yield* Deferred.succeed(gate, undefined)
			const done = yield* settled(runtime, chat)
			const failed = Option.getOrThrow(
				yield* runtimeStore.turn(chat, started.turn!),
			)
			assert.strictEqual(failed.status._tag, "Failed")
			assert.ok(failed.status._tag === "Failed")
			assert.strictEqual(failed.status.code, "model_error")
			const next = Chat.currentTurn(done.chat)!
			assert.strictEqual(next.author, "bob")
			assert.deepStrictEqual(next.input, [queued.item])
			assert.strictEqual(next.status._tag, "Completed")
		}).pipe(
			Effect.provide(
				heldModel({ ready, gate, prompts, first: Stream.fail(failure) }),
			),
		)
	})
})

it.effect(
	"the next Turn starts from the inbox after a Turn is interrupted",
	() => {
		const prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
		return Effect.gen(function* () {
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
				assert.strictEqual(queued.delivery, "queued")
				yield* runtime.interrupt({ chat, turn: started.turn! })
				const done = yield* settled(runtime, chat)
				assert.strictEqual(
					Option.getOrThrow(yield* runtimeStore.turn(chat, started.turn!))
						.status._tag,
					"Interrupted",
				)
				const next = Chat.currentTurn(done.chat)!
				assert.strictEqual(next.author, "bob")
				assert.deepStrictEqual(next.input, [queued.item])
				assert.strictEqual(next.status._tag, "Completed")
				assert.strictEqual(prompts.value.length, 2)
			}).pipe(Effect.provide(heldModel({ ready, gate, prompts })))
		})
	},
)

it.effect(
	"the next Turn reads the first run of messages from one author, and later messages wait for their own Turn",
	() => {
		const prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
		return Effect.gen(function* () {
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
				assert.deepStrictEqual(
					Arr.map([bob1, bob2, carol], (delivery) => delivery.delivery),
					["queued", "queued", "queued"],
				)
				yield* Deferred.succeed(gate, undefined)
				const done = yield* settled(runtime, chat)
				const turns = yield* runtimeStore.turns(chat)
				assert.deepStrictEqual(
					Arr.map(turns, (turn) => [turn.author, turn.input.length]),
					[
						["ada", 1],
						["bob", 2],
						["carol", 1],
					],
				)
				assert.deepStrictEqual(turns[1]!.input, [bob1.item, bob2.item])
				assert.deepStrictEqual(turns[2]!.input, [carol.item])
				assert.strictEqual(Chat.currentTurn(done.chat)!.id, turns[2]!.id)
				assert.strictEqual(prompts.value.length, 3)
			}).pipe(Effect.provide(heldModel({ ready, gate, prompts })))
		})
	},
)

it.effect(
	"two Chats run independently, and a Turn cannot start while another Turn runs",
	() =>
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
				assert.strictEqual(b.delivery, "started")
				assert.notStrictEqual(a.turn, b.turn)
				yield* Deferred.await(entered[1]!)
				const collision = yield* runtime
					.execute({ chat, input: "collision" })
					.pipe(Effect.flip)
				assert.strictEqual(collision._tag, "ChatConflict")
				const streamed = yield* runtime
					.stream({ chat, input: "collision" })
					.pipe(Stream.runDrain, Effect.flip)
				assert.strictEqual(streamed._tag, "ChatConflict")
				const action = yield* runtime
					.startAction({
						chat,
						action: { name: "Missing", arguments: {} },
					})
					.pipe(Effect.flip)
				assert.strictEqual(action._tag, "ChatConflict")
				assert.strictEqual(requests, 2)
				yield* runtime.interrupt({ chat, turn: a.turn! })
				assert.strictEqual(
					Chat.status((yield* runtimeStore.read(other.chat.id)).chat)._tag,
					"Running",
				)
				yield* Deferred.succeed(release, undefined)
				const done = yield* settled(runtime, other.chat.id)
				assert.strictEqual(Chat.status(done.chat)._tag, "Completed")
			}).pipe(Effect.provide(model))
		}),
)

it.effect(
	"closing the runtime while a Turn runs ends the Turn, keeps the waiting input in the inbox, and a new runtime can start it",
	() => {
		const prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
		return Effect.gen(function* () {
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
					assert.strictEqual(steered.delivery, "steered")
					const queued = yield* runtime.deliver({
						chat,
						input: "from bob",
						author: "bob",
					})
					assert.strictEqual(queued.delivery, "queued")
					return { chat, running, steered, queued }
				}),
			).pipe(Effect.provide(model))
			yield* Effect.gen(function* () {
				// A new runtime over the same persistence, as after a restart.
				const { runtime, runtimeStore } = yield* ChatTest({}, { persistence })
				const closed = yield* runtimeStore.read(first.chat)
				assert.strictEqual(
					Chat.currentTurn(closed.chat)!.id,
					first.running.turn,
				)
				assert.strictEqual(Chat.status(closed.chat)._tag, "Interrupted")
				assert.deepStrictEqual(
					Arr.map(closed.chat.inbox, (entry) => [entry.id, entry.kind]),
					[
						[first.steered.item, "message"],
						[first.queued.item, "message"],
					],
				)
				assert.strictEqual((yield* runtimeStore.turns(first.chat)).length, 1)
				const next = yield* runtime.drain(first.chat)
				assert.strictEqual(Option.getOrThrow(next).item, first.steered.item)
				yield* settled(runtime, first.chat)
				const turns = yield* runtimeStore.turns(first.chat)
				assert.deepStrictEqual(
					Arr.map(turns, (turn) => [turn.author, turn.status._tag]),
					[
						["ada", "Interrupted"],
						["ada", "Completed"],
						["bob", "Completed"],
					],
				)
			}).pipe(Effect.provide(model))
		})
	},
	5000,
)

it.effect(
	"drain starts a Turn for input that waits in an idle Chat, and does nothing when no input waits",
	() =>
		Effect.gen(function* () {
			const { runtime, runtimeStore, chat } = yield* ChatTest()
			assert.isTrue(Option.isNone(yield* runtime.drain(chat)))
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
			assert.ok(Option.isSome(delivery))
			assert.strictEqual(delivery.value.delivery, "started")
			assert.strictEqual(delivery.value.item, waiting)
			const done = yield* settled(runtime, chat)
			const turn = Chat.currentTurn(done.chat)!
			assert.strictEqual(turn.id, delivery.value.turn)
			assert.strictEqual(turn.author, "ada")
			assert.deepStrictEqual(turn.input, [waiting])
			assert.strictEqual(turn.status._tag, "Completed")
			assert.isTrue(Option.isNone(yield* runtime.drain(chat)))
		}).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () => Stream.fromArray(textParts("done")),
				}),
			),
		),
)

it.effect(
	"a new runtime does not restart a running Turn of the store; interrupt ends it, and drain starts the waiting input",
	() => {
		const prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
		return Effect.gen(function* () {
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
				assert.strictEqual(yield* restored.isActive(chat), false)
				assert.isTrue(Option.isNone(yield* restored.drain(chat)))
				const queued = yield* restored.deliver({
					chat,
					input: "stay queued",
					author: "bob",
				})
				assert.strictEqual(queued.delivery, "queued")
				assert.strictEqual(prompts.value.length, 1)
				const stopped = yield* restored.interrupt({
					chat,
					turn: running.turn!,
				})
				assert.strictEqual(Chat.status(stopped.chat)._tag, "Interrupted")
				assert.strictEqual(stopped.chat.inbox.length, 1)
				const next = yield* restored.drain(chat)
				assert.ok(Option.isSome(next))
				assert.strictEqual(next.value.item, queued.item)
				const done = yield* settled(restored, chat)
				assert.strictEqual(Chat.currentTurn(done.chat)!.author, "bob")
				assert.strictEqual(Chat.status(done.chat)._tag, "Completed")
				assert.strictEqual(prompts.value.length, 2)
			}).pipe(Effect.provide(heldModel({ ready, gate, prompts })))
		})
	},
)

it.effect(
	"closing the runtime stops a Turn that a caller streams, the caller sees the end, and nothing logs a warning",
	() => {
		const prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
		let warnings: ReadonlyArray<unknown> = []
		const collector = Logger.layer([
			Logger.make((log) => {
				if (log.logLevel === "Warn" || log.logLevel === "Error")
					warnings = Arr.append(warnings, log.message)
			}),
		])
		return Effect.gen(function* () {
			const ready = yield* Deferred.make<void>(),
				gate = yield* Deferred.make<void>()
			yield* Effect.gen(function* () {
				const persistence = yield* MemoryPersistence.make
				const scope = yield* Scope.fork(yield* Effect.scope)
				const { runtime, chat } = yield* ChatTest({}, { persistence }).pipe(
					Scope.provide(scope),
				)
				const running = yield* Effect.forkChild(
					runtime.execute({ chat, input: "work" }),
				)
				yield* Deferred.await(ready)
				assert.strictEqual(yield* runtime.isActive(chat), true)
				yield* Scope.close(scope, Exit.void)
				const exit = yield* Fiber.await(running)
				assert.ok(Exit.isFailure(exit))
				assert.ok(Cause.hasInterruptsOnly(exit.cause))
				// A new runtime over the same persistence, as after a restart.
				const { runtimeStore } = yield* ChatTest({}, { persistence })
				const closed = yield* runtimeStore.read(chat)
				assert.strictEqual(Chat.status(closed.chat)._tag, "Interrupted")
				assert.strictEqual(closed.state.conversation.closed, true)
				assert.deepStrictEqual(warnings, [])
			}).pipe(
				Effect.provide(
					Layer.merge(heldModel({ ready, gate, prompts }), collector),
				),
			)
		})
	},
	5000,
)
