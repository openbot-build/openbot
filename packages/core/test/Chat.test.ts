import { assert, it } from "@effect/vitest"
import {
	Array as Arr,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	HashMap,
	Layer,
	Match,
	Option,
	Schema,
	Stream,
} from "effect"
import { Prompt, Response, Tool, Toolkit } from "effect/ai"
import { Chat, ChatRuntime, ChatState, Plugin, Turn } from "@openbot-build/core"
import { ChatTest, settled } from "./ChatTest.ts"
import { LanguageModelTest, finish, textParts } from "./LanguageModelTest.ts"

const Echo = Tool.make("Echo", {
	parameters: Schema.Struct({ text: Schema.String }),
	success: Schema.String,
})
const tools = Toolkit.make(Echo)
const call = (id = "echo-1") =>
	Response.makePart("tool-call", {
		id,
		name: "Echo",
		params: { text: id },
		providerExecuted: false,
	})
const handlers = tools.toLayer({
	Echo: ({ text }) => Effect.succeed("tool:" + text),
})
/** The tool results in a prompt, in order. */
const results = (prompt: Prompt.Prompt) =>
	Arr.flatMap(prompt.content, (message) =>
		message.role === "tool"
			? Arr.filter(message.content, (part) => part.type === "tool-result")
			: [],
	)
const hasResult = (prompt: Prompt.Prompt) => results(prompt).length > 0
/** The JSON text of a value, so a test can match a pattern in it. */
const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

it.effect(
	"a multi-step tool loop has one Turn and stable Item identities",
	() => {
		let requests = 0
		return Effect.gen(function* () {
			const { runtime, runtimeStore, chat } = yield* ChatTest({
				toolkit: tools,
			})
			const events = yield* Stream.runCollect(
				runtime.stream({ chat, input: "echo" }),
			)
			const started = Arr.filter(
					events,
					(event) => event._tag === "TurnStarted",
				),
				steps = Arr.filter(events, (event) => event._tag === "ModelStepStarted")
			assert.strictEqual(started.length, 1)
			assert.strictEqual(steps.length, 2)
			assert.ok(Arr.every(steps, (event) => event.turn === started[0]!.turn))
			const view = yield* runtimeStore.read(chat),
				turn = Chat.currentTurn(view.chat)!
			assert.strictEqual(turn.id, started[0]!.turn)
			assert.strictEqual(turn.status._tag, "Completed")
			assert.strictEqual(turn.steps, 2)
			const items = yield* runtimeStore.items(chat)
			assert.deepStrictEqual(
				Arr.map(ChatState.promptOf(items).content, (message) => message.role),
				["user", "assistant", "tool", "assistant"],
			)
			assert.deepStrictEqual(
				turn.items,
				Arr.map(items, (item) => item.id),
			)
			assert.deepStrictEqual(turn.input, [items[0]!.id])
			assert.strictEqual(view.chat.seq, items.length)
			const parts = Arr.filter(events, (event) => event._tag === "ResponsePart")
			assert.ok(
				Arr.every(parts, (event) =>
					Arr.some(items, (item) => item.id === event.item),
				),
			)
			assert.strictEqual(requests, 2)
		}).pipe(
			Effect.provide(
				Layer.merge(
					handlers,
					LanguageModelTest({
						streamText: ({ prompt }) => {
							requests++
							return hasResult(prompt)
								? Stream.fromArray(textParts("answer"))
								: Stream.make(call(), finish("tool-calls"))
						},
					}),
				),
			),
		)
	},
)

it.effect(
	"a settings change moves the revision but not the Item log or a completed Turn",
	() =>
		Effect.gen(function* () {
			const { runtime, runtimeStore, chat } = yield* ChatTest()
			const first = yield* runtime.execute({ chat, input: "first" }),
				record = Chat.currentTurn(first.chat)!
			const changed = (yield* runtimeStore.modifyEffect({
				chat,
				expectedRevision: first.chat.revision,
				update: (current) =>
					Effect.succeed([
						undefined,
						Option.some({
							chat: { settings: { ...current.chat.settings, mode: "plan" } },
						}),
					] as const),
			})).view
			assert.strictEqual(changed.chat.revision, first.chat.revision + 1)
			assert.strictEqual(changed.chat.seq, first.chat.seq)
			assert.deepStrictEqual(changed.state, first.state)
			assert.deepStrictEqual(Chat.currentTurn(changed.chat), record)
			const next = yield* runtime.execute({ chat, input: "next" })
			assert.strictEqual(Chat.currentTurn(next.chat)!.settings.mode, "plan")
			assert.notStrictEqual(Chat.currentTurn(next.chat)!.id, record.id)
			const turns = yield* runtimeStore.turns(chat)
			assert.deepStrictEqual(
				Arr.map(turns, (turn) => turn.settings.mode),
				["build", "plan"],
			)
			assert.deepStrictEqual(
				yield* runtimeStore.turn(chat, record.id),
				Option.some(record),
			)
		}).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () => Stream.fromArray(textParts("done")),
				}),
			),
		),
)

it.effect("interrupt needs the current Turn ID and ends the running Turn", () =>
	Effect.gen(function* () {
		const entered = yield* Deferred.make<void>()
		const model = LanguageModelTest({
			streamText: () =>
				Stream.fromEffect(Deferred.succeed(entered, undefined)).pipe(
					Stream.flatMap(() => Stream.never),
				),
		})
		yield* Effect.gen(function* () {
			const { runtime, runtimeStore, chat } = yield* ChatTest()
			const running = yield* Effect.forkChild(
				runtime.execute({ chat, input: "running" }),
			)
			yield* Deferred.await(entered)
			const turn = Chat.currentTurn((yield* runtimeStore.read(chat)).chat)!
			assert.strictEqual(turn.status._tag, "Running")
			assert.strictEqual(yield* runtime.isActive(chat), true)
			const wrong = yield* runtime
				.interrupt({ chat, turn: Turn.Id.make("old") })
				.pipe(Effect.flip)
			assert.strictEqual(wrong._tag, "TurnConflict")
			const stopped = yield* runtime.interrupt({ chat, turn: turn.id })
			assert.strictEqual(Chat.status(stopped.chat)._tag, "Interrupted")
			const exit = yield* Fiber.await(running)
			assert.ok(Exit.isFailure(exit))
			assert.ok(Cause.hasInterruptsOnly(exit.cause))
			assert.strictEqual(yield* runtime.isActive(chat), false)
			const again = yield* runtime
				.interrupt({ chat, turn: turn.id })
				.pipe(Effect.flip)
			assert.strictEqual(again._tag, "TurnConflict")
		}).pipe(Effect.provide(model))
	}),
)

it.effect(
	"steer input that a Turn did not read goes back to the inbox and starts the next Turn",
	() => {
		let requests: ReadonlyArray<Prompt.Prompt> = []
		return Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const model = LanguageModelTest({
				streamText: ({ prompt }) => {
					requests = Arr.append(requests, prompt)
					return requests.length === 1
						? Stream.fromEffect(Deferred.succeed(entered, undefined)).pipe(
								Stream.flatMap(() => Stream.never),
							)
						: Stream.fromArray(textParts("done"))
				},
			})
			yield* Effect.gen(function* () {
				const { runtime, runtimeStore, chat } = yield* ChatTest()
				const first = yield* runtime.deliver({
					chat,
					input: "first",
					author: "ada",
				})
				assert.strictEqual(first.delivery, "started")
				yield* Deferred.await(entered)
				const steered = yield* runtime.deliver({
					chat,
					input: "more from ada",
					author: "ada",
				})
				assert.strictEqual(steered.delivery, "steered")
				assert.strictEqual(steered.turn, first.turn)
				const backInInbox = yield* runtimeStore.changes({ chat }).pipe(
					Stream.filter(
						(change) =>
							change._tag === "Committed" &&
							change.view.chat.turn !== undefined &&
							change.view.chat.turn.id === first.turn &&
							change.view.chat.turn.status._tag === "Interrupted" &&
							Arr.some(
								change.view.chat.inbox,
								(entry) =>
									entry.id === steered.item &&
									entry.kind === "message" &&
									entry.turn === undefined,
							),
					),
					Stream.runHead,
					Effect.forkChild({ startImmediately: true }),
				)
				yield* runtime.interrupt({ chat, turn: first.turn! })
				const view = yield* settled(runtime, chat)
				const interrupted = Option.getOrThrow(
					yield* runtimeStore.turn(chat, first.turn!),
				)
				assert.strictEqual(interrupted.status._tag, "Interrupted")
				assert.strictEqual(interrupted.items.includes(steered.item), false)
				const next = Chat.currentTurn(view.chat)!
				assert.notStrictEqual(next.id, first.turn)
				assert.strictEqual(next.author, "ada")
				assert.deepStrictEqual(next.input, [steered.item])
				assert.strictEqual(next.status._tag, "Completed")
				assert.ok(Option.isSome(yield* Fiber.join(backInInbox)))
				assert.match(yield* json(requests.at(-1)), /more from ada/)
			}).pipe(Effect.provide(model))
		})
	},
)

const approved = Toolkit.make(Echo.setNeedsApproval(true))
/** A model that calls Echo until it sees a tool result. */
const approvalModel = (
	prompts: { value: ReadonlyArray<Prompt.Prompt> },
	parts: ReadonlyArray<Response.StreamPartEncoded> = [
		call(),
		finish("tool-calls"),
	],
) =>
	LanguageModelTest({
		streamText: ({ prompt }) => {
			prompts.value = Arr.append(prompts.value, prompt)
			return hasResult(prompt)
				? Stream.fromArray(textParts("done"))
				: Stream.fromArray(parts)
		},
	})
const counted = (calls: { value: number }) =>
	approved.toLayer({
		Echo: ({ text }) =>
			Effect.sync(() => {
				calls.value++
				return "ran:" + text
			}),
	})

it.effect(
	"a decider that allows a call lets the tool run in the next model request",
	() => {
		const calls = { value: 0 },
			prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
		let requests: ReadonlyArray<Chat.ApprovalRequest> = []
		return Effect.gen(function* () {
			const { runtime, chat } = yield* ChatTest({
				toolkit: approved,
				approvals: {
					decide: (request) =>
						Effect.sync(() => {
							requests = Arr.append(requests, request)
							return Chat.Decision.Allow()
						}),
				},
			})
			const done = yield* runtime.execute({
				chat,
				input: "approve",
				author: "ada",
			})
			const turn = Chat.currentTurn(done.chat)!
			assert.strictEqual(turn.status._tag, "Completed")
			assert.strictEqual(calls.value, 1)
			assert.strictEqual(requests.length, 1)
			assert.strictEqual(requests[0]!.chat, chat)
			assert.strictEqual(requests[0]!.turn, turn.id)
			assert.strictEqual(requests[0]!.author, "ada")
			assert.strictEqual(requests[0]!.toolCall.id, "echo-1")
			assert.strictEqual(requests[0]!.toolCall.name, "Echo")
			assert.deepStrictEqual(
				Arr.map(results(prompts.value[1]!), (part) => part.result),
				["ran:echo-1"],
			)
		}).pipe(Effect.provide(Layer.merge(approvalModel(prompts), counted(calls))))
	},
)

it.effect(
	"a decider that denies a call keeps the tool from running, and the model sees the reason",
	() => {
		const calls = { value: 0 },
			prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
		return Effect.gen(function* () {
			const { runtime, chat } = yield* ChatTest({
				toolkit: approved,
				approvals: {
					decide: () =>
						Effect.succeed(Chat.Decision.Deny({ reason: "not now" })),
				},
			})
			const done = yield* runtime.execute({ chat, input: "deny" })
			assert.strictEqual(Chat.status(done.chat)._tag, "Completed")
			assert.strictEqual(calls.value, 0)
			const [denied] = results(prompts.value[1]!)
			assert.ok(denied)
			assert.strictEqual(denied.isFailure, true)
			assert.match(yield* json(denied.result), /not now/)
		}).pipe(Effect.provide(Layer.merge(approvalModel(prompts), counted(calls))))
	},
)

it.effect(
	"a pending decision gives its result to the model at once, and the Turn goes on",
	() => {
		const calls = { value: 0 },
			prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
		return Effect.gen(function* () {
			const { runtime, runtimeStore, chat } = yield* ChatTest({
				toolkit: approved,
				approvals: {
					decide: () =>
						Effect.succeed(
							Chat.Decision.Pending({ result: "a person will decide" }),
						),
				},
			})
			const done = yield* runtime.execute({ chat, input: "wait" })
			assert.strictEqual(Chat.status(done.chat)._tag, "Completed")
			assert.strictEqual(calls.value, 0)
			assert.strictEqual(prompts.value.length, 2)
			assert.deepStrictEqual(
				Arr.map(results(prompts.value[1]!), (part) => part.result),
				["a person will decide"],
			)
			const items = yield* runtimeStore.items(chat)
			assert.strictEqual(
				HashMap.size(ChatState.unansweredCalls(items)),
				0,
				"every call has a result",
			)
		}).pipe(Effect.provide(Layer.merge(approvalModel(prompts), counted(calls))))
	},
)

it.effect(
	"without a decider, every call that asks for approval is pending, so the Turn never waits",
	() => {
		const calls = { value: 0 },
			prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
		return Effect.gen(function* () {
			const { runtime, chat } = yield* ChatTest({ toolkit: approved })
			const events = yield* Stream.runCollect(
				runtime.stream({ chat, input: "no decider" }),
			)
			const completed = Arr.filter(
				events,
				(event) => event._tag === "TurnCompleted",
			)
			assert.strictEqual(completed.length, 1)
			assert.strictEqual(completed[0]!.turn.status._tag, "Completed")
			assert.strictEqual(calls.value, 0)
			const [pending] = results(prompts.value[1]!)
			assert.ok(pending)
			assert.strictEqual(pending.isFailure, false)
			assert.deepStrictEqual(pending.result, ChatRuntime.pendingResult)
		}).pipe(Effect.provide(Layer.merge(approvalModel(prompts), counted(calls))))
	},
)

it.effect(
	"the Approvals service can come from the context of the runtime",
	() => {
		const calls = { value: 0 },
			prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
		let decisions = 0
		return Effect.gen(function* () {
			const { runtime, chat } = yield* ChatTest({ toolkit: approved }).pipe(
				Effect.provideService(Chat.Approvals, {
					decide: () =>
						Effect.sync(() => {
							decisions++
							return Chat.Decision.Allow()
						}),
				}),
			)
			yield* runtime.execute({ chat, input: "from the context" })
			assert.strictEqual(decisions, 1)
			assert.strictEqual(calls.value, 1)
		}).pipe(Effect.provide(Layer.merge(approvalModel(prompts), counted(calls))))
	},
)

it.effect("two calls in one step get one decision each", () => {
	const calls = { value: 0 },
		prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
	return Effect.gen(function* () {
		const { runtime, chat } = yield* ChatTest({
			toolkit: approved,
			approvals: {
				decide: (request) =>
					Effect.succeed(
						request.toolCall.id === "echo-1"
							? Chat.Decision.Allow()
							: Chat.Decision.Pending({ result: "later" }),
					),
			},
		})
		const done = yield* runtime.execute({ chat, input: "two" })
		assert.strictEqual(Chat.status(done.chat)._tag, "Completed")
		assert.strictEqual(calls.value, 1)
		const answers = results(prompts.value[1]!)
		assert.deepStrictEqual(
			Arr.map(answers, (part) => [part.id, part.result]),
			[
				["echo-2", "later"],
				["echo-1", "ran:echo-1"],
			],
		)
	}).pipe(
		Effect.provide(
			Layer.merge(
				approvalModel(prompts, [
					call("echo-1"),
					call("echo-2"),
					finish("tool-calls"),
				]),
				counted(calls),
			),
		),
	)
})

it.effect(
	"an allowed call that comes back later runs in the Turn that reads it, without asking again",
	() => {
		const calls = { value: 0 },
			prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
		let decisions: ReadonlyArray<Chat.ApprovalRequest> = []
		return Effect.gen(function* () {
			const { runtime, runtimeStore, chat } = yield* ChatTest({
				toolkit: approved,
				approvals: {
					decide: (request) =>
						Effect.sync(() => {
							decisions = Arr.append(decisions, request)
							return Chat.Decision.Pending({ result: "a person will decide" })
						}),
				},
			})
			yield* runtime.execute({ chat, input: "ask" })
			assert.strictEqual(decisions.length, 1)
			assert.strictEqual(calls.value, 0)
			const request = decisions[0]!
			// The pending call already has a result with its ID, so the host gives
			// the allowed call a new ID.
			const delivery = yield* runtime.deliver({
				chat,
				input: "A person allowed the call.",
				approved: {
					id: request.toolCall.id + "-allowed",
					name: request.toolCall.name,
					params: request.toolCall.params as Schema.Json,
				},
			})
			assert.strictEqual(delivery.delivery, "started")
			const view = yield* settled(runtime, chat)
			assert.strictEqual(Chat.status(view.chat)._tag, "Completed")
			assert.strictEqual(calls.value, 1)
			assert.strictEqual(decisions.length, 1)
			const items = yield* runtimeStore.items(chat, { turn: delivery.turn! })
			assert.match(yield* json(items), /ran:echo-1/)
			assert.strictEqual(HashMap.size(ChatState.unansweredCalls(items)), 0)
		}).pipe(Effect.provide(Layer.merge(approvalModel(prompts), counted(calls))))
	},
)

it.effect(
	"an allowed call whose tool is not open does not run, and the Turn goes on",
	() => {
		const calls = { value: 0 },
			prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
		return Effect.gen(function* () {
			const { runtime, runtimeStore, chat } = yield* ChatTest({
				toolkit: approved,
			})
			// The host allows a call of a tool that this Bot does not have now.
			const delivery = yield* runtime.deliver({
				chat,
				input: "A person allowed the call.",
				approved: {
					id: "gone-allowed",
					name: "Gone",
					params: { text: "never" },
				},
			})
			const view = yield* settled(runtime, chat)
			assert.strictEqual(Chat.status(view.chat)._tag, "Completed")
			assert.strictEqual(calls.value, 0)
			const items = yield* runtimeStore.items(chat, { turn: delivery.turn! })
			assert.match(yield* json(items), /did not run/)
			// The saved history has a result for the call, so a provider takes it.
			assert.strictEqual(HashMap.size(ChatState.unansweredCalls(items)), 0)
		}).pipe(Effect.provide(Layer.merge(approvalModel(prompts), counted(calls))))
	},
)

it.effect(
	"interrupt keeps an external receipt while another tool is still running",
	() => {
		const Slow = Tool.make("Slow", {
			parameters: Schema.Struct({}),
			success: Schema.String,
		})
		const concurrent = Toolkit.make(Echo, Slow)
		return Effect.gen(function* () {
			const received = yield* Deferred.make<void>()
			const { runtime, runtimeStore, chat } = yield* ChatTest({
				toolkit: concurrent,
				concurrency: "unbounded",
			})
			const running = yield* runtime
				.stream({ chat, input: "perform tools" })
				.pipe(
					Stream.tap((event) =>
						Match.value(event).pipe(
							Match.when(
								{
									_tag: "ResponsePart",
									part: { type: "tool-result", name: "Echo" },
								},
								() => Deferred.succeed(received, undefined),
							),
							Match.orElse(() => Effect.void),
						),
					),
					Stream.runDrain,
					Effect.forkChild,
				)
			yield* Deferred.await(received)
			yield* Fiber.interrupt(running)
			const view = yield* runtimeStore.read(chat)
			assert.strictEqual(
				Chat.currentTurn(view.chat)!.status._tag,
				"Interrupted",
			)
			assert.strictEqual(view.state.conversation.closed, true)
			const items = yield* runtimeStore.items(chat)
			assert.match(yield* json(items), /actual external receipt/)
			assert.strictEqual(HashMap.size(ChatState.unansweredCalls(items)), 0)
		}).pipe(
			Effect.provide(
				Layer.merge(
					concurrent.toLayer({
						Echo: () => Effect.succeed("actual external receipt"),
						Slow: () => Effect.never,
					}),
					LanguageModelTest({
						streamText: () =>
							Stream.make(
								call(),
								Response.makePart("tool-call", {
									id: "slow",
									name: "Slow",
									params: {},
									providerExecuted: false,
								}),
								finish("tool-calls"),
							),
					}),
				),
			),
		)
	},
	5000,
)

it.effect(
	"an activity wait wakes after the final resources are released, without a new revision",
	() =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const plugin = Plugin.make({ id: Plugin.Id.make("delayed-finalizer") })(
				() =>
					Effect.succeed((next, options) =>
						next(options).pipe(
							Stream.ensuring(
								Deferred.succeed(entered, undefined).pipe(
									Effect.andThen(Deferred.await(release)),
								),
							),
						),
					),
			)
			const { runtime, runtimeStore, chat } = yield* ChatTest({ plugin })
			const delivery = yield* runtime.deliver({ chat, input: "finish" })
			assert.strictEqual(delivery.delivery, "started")
			yield* Deferred.await(entered)
			yield* Effect.gen(function* () {
				const completed = yield* runtimeStore.read(chat)
				assert.strictEqual(Chat.status(completed.chat)._tag, "Completed")
				assert.strictEqual(yield* runtime.isActive(chat), true)
				const waiting = yield* Effect.forkChild(
					runtime.wait({
						chat,
						after: completed.chat.revision,
						afterActive: true,
						timeout: "5 seconds",
					}),
					{ startImmediately: true },
				)
				yield* Deferred.succeed(release, undefined)
				// The test clock does not move, so only the activity signal can end these waits.
				const woken = yield* Fiber.join(waiting)
				assert.strictEqual(woken.chat.revision, completed.chat.revision)
				assert.strictEqual(yield* runtime.isActive(chat), false)
				yield* runtime.wait({
					chat,
					after: woken.chat.revision,
					afterActive: true,
					timeout: "5 seconds",
				})
			}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
		}).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () => Stream.fromArray(textParts("done")),
				}),
			),
		),
)

it.effect("a caller that stops reading a stream early stops the Turn", () =>
	Effect.gen(function* () {
		const { runtime, runtimeStore, chat } = yield* ChatTest()
		// The model never answers, so only the end of the reading can end the Turn.
		const read = yield* runtime.stream({ chat, input: "stop early" }).pipe(
			Stream.takeUntil((event) => event._tag === "ModelStepStarted"),
			Stream.runCollect,
		)
		assert.strictEqual(read.at(-1)?._tag, "ModelStepStarted")
		const view = yield* runtimeStore.read(chat)
		assert.strictEqual(Chat.status(view.chat)._tag, "Interrupted")
		assert.strictEqual(view.state.conversation.closed, true)
		assert.strictEqual(yield* runtime.isActive(chat), false)
	}).pipe(
		Effect.provide(LanguageModelTest({ streamText: () => Stream.never })),
	),
)
