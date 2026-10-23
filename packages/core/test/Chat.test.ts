// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import {
	Array as EffectArray,
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
import { Chat, ChatState, Plugin, Turn } from "@openbot-build/core"
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
	prompt.content.flatMap((message) =>
		message.role === "tool"
			? message.content.filter((part) => part.type === "tool-result")
			: [],
	)
const hasResult = (prompt: Prompt.Prompt) => results(prompt).length > 0

test("a multi-step tool loop has one Turn and stable Item identities", async () => {
	let requests = 0
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { runtime, runtimeStore, chat } = yield* ChatTest({
					toolkit: tools,
				})
				const events = yield* Stream.runCollect(
					runtime.stream({ chat, input: "echo" }),
				)
				const started = events.filter((event) => event._tag === "TurnStarted"),
					steps = events.filter((event) => event._tag === "ModelStepStarted")
				assert.equal(started.length, 1)
				assert.equal(steps.length, 2)
				assert.ok(steps.every((event) => event.turn === started[0]!.turn))
				const view = yield* runtimeStore.read(chat),
					turn = Chat.currentTurn(view.chat)!
				assert.equal(turn.id, started[0]!.turn)
				assert.equal(turn.status._tag, "Completed")
				assert.equal(turn.steps, 2)
				const items = yield* runtimeStore.items(chat)
				assert.deepEqual(
					ChatState.promptOf(items).content.map((message) => message.role),
					["user", "assistant", "tool", "assistant"],
				)
				assert.deepEqual(
					turn.items,
					items.map((item) => item.id),
				)
				assert.deepEqual(turn.input, [items[0]!.id])
				assert.equal(view.chat.seq, items.length)
				const parts = events.filter((event) => event._tag === "ResponsePart")
				assert.ok(
					parts.every((event) => items.some((item) => item.id === event.item)),
				)
				assert.equal(requests, 2)
			}),
		).pipe(
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
		),
	)
})

test("a settings change moves the revision but not the Item log or a completed Turn", async () => {
	await Effect.runPromise(
		Effect.scoped(
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
				assert.equal(changed.chat.revision, first.chat.revision + 1)
				assert.equal(changed.chat.seq, first.chat.seq)
				assert.deepEqual(changed.state, first.state)
				assert.deepEqual(Chat.currentTurn(changed.chat), record)
				const next = yield* runtime.execute({ chat, input: "next" })
				assert.equal(Chat.currentTurn(next.chat)!.settings.mode, "plan")
				assert.notEqual(Chat.currentTurn(next.chat)!.id, record.id)
				const turns = yield* runtimeStore.turns(chat)
				assert.deepEqual(
					turns.map((turn) => turn.settings.mode),
					["build", "plan"],
				)
				assert.deepEqual(
					yield* runtimeStore.turn(chat, record.id),
					Option.some(record),
				)
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

test("interrupt needs the current Turn ID and ends the running Turn", async () => {
	await Effect.runPromise(
		Effect.scoped(
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
					assert.equal(turn.status._tag, "Running")
					assert.equal(yield* runtime.isActive(chat), true)
					const wrong = yield* runtime
						.interrupt({ chat, turn: Turn.Id.make("old") })
						.pipe(Effect.flip)
					assert.equal(wrong._tag, "TurnConflict")
					const stopped = yield* runtime.interrupt({ chat, turn: turn.id })
					assert.equal(Chat.status(stopped.chat)._tag, "Interrupted")
					assert.ok(Exit.isFailure(yield* Fiber.await(running)))
					assert.equal(yield* runtime.isActive(chat), false)
					const again = yield* runtime
						.interrupt({ chat, turn: turn.id })
						.pipe(Effect.flip)
					assert.equal(again._tag, "TurnConflict")
				}).pipe(Effect.provide(model))
			}),
		),
	)
})

test("steer input that a Turn did not read goes back to the inbox and starts the next Turn", async () => {
	let requests: ReadonlyArray<Prompt.Prompt> = []
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const model = LanguageModelTest({
					streamText: ({ prompt }) => {
						requests = EffectArray.append(requests, prompt)
						return requests.length === 1
							? Stream.fromEffect(Deferred.succeed(entered, undefined)).pipe(
									Stream.flatMap(() => Stream.never),
								)
							: Stream.fromArray(textParts("done"))
					},
				})
				yield* Effect.gen(function* () {
					const { runtime, runtimeStore, chat } = yield* ChatTest()
					let views: ReadonlyArray<Chat.View<{}>> = []
					yield* Effect.forkChild(
						runtimeStore.changes({ chat }).pipe(
							Stream.runForEach((change) =>
								Effect.sync(() => {
									if (change._tag === "Committed")
										views = EffectArray.append(views, change.view)
								}),
							),
						),
						{ startImmediately: true },
					)
					const first = yield* runtime.deliver({
						chat,
						input: "first",
						author: "ada",
					})
					assert.equal(first.delivery, "started")
					yield* Deferred.await(entered)
					const steered = yield* runtime.deliver({
						chat,
						input: "more from ada",
						author: "ada",
					})
					assert.equal(steered.delivery, "steered")
					assert.equal(steered.turn, first.turn)
					yield* runtime.interrupt({ chat, turn: first.turn! })
					const view = yield* settled(runtime, chat)
					const interrupted = Option.getOrThrow(
						yield* runtimeStore.turn(chat, first.turn!),
					)
					assert.equal(interrupted.status._tag, "Interrupted")
					assert.equal(interrupted.items.includes(steered.item), false)
					const next = Chat.currentTurn(view.chat)!
					assert.notEqual(next.id, first.turn)
					assert.equal(next.author, "ada")
					assert.deepEqual(next.input, [steered.item])
					assert.equal(next.status._tag, "Completed")
					assert.ok(
						views.some(
							(view) =>
								view.chat.turn !== undefined &&
								view.chat.turn.id === first.turn &&
								view.chat.turn.status._tag === "Interrupted" &&
								view.chat.inbox.some(
									(entry) =>
										entry.id === steered.item &&
										entry.kind === "message" &&
										entry.turn === undefined,
								),
						),
					)
					assert.match(JSON.stringify(requests.at(-1)), /more from ada/)
				}).pipe(Effect.provide(model))
			}),
		),
	)
})

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
			prompts.value = EffectArray.append(prompts.value, prompt)
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

test("a decider that allows a call lets the tool run in the next model request", async () => {
	const calls = { value: 0 },
		prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
	let requests: ReadonlyArray<Chat.ApprovalRequest> = []
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { runtime, chat } = yield* ChatTest({
					toolkit: approved,
					approvals: {
						decide: (request) =>
							Effect.sync(() => {
								requests = EffectArray.append(requests, request)
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
				assert.equal(turn.status._tag, "Completed")
				assert.equal(calls.value, 1)
				assert.equal(requests.length, 1)
				assert.equal(requests[0]!.chat, chat)
				assert.equal(requests[0]!.turn, turn.id)
				assert.equal(requests[0]!.author, "ada")
				assert.equal(requests[0]!.toolCall.id, "echo-1")
				assert.equal(requests[0]!.toolCall.name, "Echo")
				assert.deepEqual(
					results(prompts.value[1]!).map((part) => part.result),
					["ran:echo-1"],
				)
			}),
		).pipe(Effect.provide(Layer.merge(approvalModel(prompts), counted(calls)))),
	)
})

test("a decider that denies a call keeps the tool from running, and the model sees the reason", async () => {
	const calls = { value: 0 },
		prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { runtime, chat } = yield* ChatTest({
					toolkit: approved,
					approvals: {
						decide: () =>
							Effect.succeed(Chat.Decision.Deny({ reason: "not now" })),
					},
				})
				const done = yield* runtime.execute({ chat, input: "deny" })
				assert.equal(Chat.status(done.chat)._tag, "Completed")
				assert.equal(calls.value, 0)
				const [denied] = results(prompts.value[1]!)
				assert.ok(denied)
				assert.equal(denied.isFailure, true)
				assert.match(JSON.stringify(denied.result), /not now/)
			}),
		).pipe(Effect.provide(Layer.merge(approvalModel(prompts), counted(calls)))),
	)
})

test("a pending decision gives its result to the model at once, and the Turn goes on", async () => {
	const calls = { value: 0 },
		prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
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
				assert.equal(Chat.status(done.chat)._tag, "Completed")
				assert.equal(calls.value, 0)
				assert.equal(prompts.value.length, 2)
				assert.deepEqual(
					results(prompts.value[1]!).map((part) => part.result),
					["a person will decide"],
				)
				const items = yield* runtimeStore.items(chat)
				assert.equal(
					HashMap.size(ChatState.unansweredCalls(items)),
					0,
					"every call has a result",
				)
			}),
		).pipe(Effect.provide(Layer.merge(approvalModel(prompts), counted(calls)))),
	)
})

test("without a decider, every call that asks for approval is pending, so the Turn never waits", async () => {
	const calls = { value: 0 },
		prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { runtime, chat } = yield* ChatTest({ toolkit: approved })
				const events = yield* Stream.runCollect(
					runtime.stream({ chat, input: "no decider" }),
				)
				const completed = events.filter(
					(event) => event._tag === "TurnCompleted",
				)
				assert.equal(completed.length, 1)
				assert.equal(completed[0]!.turn.status._tag, "Completed")
				assert.equal(calls.value, 0)
				const [pending] = results(prompts.value[1]!)
				assert.ok(pending)
				assert.equal(pending.isFailure, false)
				assert.match(JSON.stringify(pending.result), /"pending":true/)
			}),
		).pipe(Effect.provide(Layer.merge(approvalModel(prompts), counted(calls)))),
	)
})

test("the Approvals service can come from the context of the runtime", async () => {
	const calls = { value: 0 },
		prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
	let decisions = 0
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
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
				assert.equal(decisions, 1)
				assert.equal(calls.value, 1)
			}),
		).pipe(Effect.provide(Layer.merge(approvalModel(prompts), counted(calls)))),
	)
})

test("two calls in one step get one decision each", async () => {
	const calls = { value: 0 },
		prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
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
				assert.equal(Chat.status(done.chat)._tag, "Completed")
				assert.equal(calls.value, 1)
				const answers = results(prompts.value[1]!)
				assert.deepEqual(
					answers.map((part) => [part.id, part.result]),
					[
						["echo-2", "later"],
						["echo-1", "ran:echo-1"],
					],
				)
			}),
		).pipe(
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
		),
	)
})

test("an allowed call that comes back later runs in the Turn that reads it, without asking again", async () => {
	const calls = { value: 0 },
		prompts = { value: [] as ReadonlyArray<Prompt.Prompt> }
	let decisions: ReadonlyArray<Chat.ApprovalRequest> = []
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { runtime, runtimeStore, chat } = yield* ChatTest({
					toolkit: approved,
					approvals: {
						decide: (request) =>
							Effect.sync(() => {
								decisions = EffectArray.append(decisions, request)
								return Chat.Decision.Pending({ result: "a person will decide" })
							}),
					},
				})
				yield* runtime.execute({ chat, input: "ask" })
				assert.equal(decisions.length, 1)
				assert.equal(calls.value, 0)
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
				assert.equal(delivery.delivery, "started")
				const view = yield* settled(runtime, chat)
				assert.equal(Chat.status(view.chat)._tag, "Completed")
				assert.equal(calls.value, 1)
				assert.equal(decisions.length, 1)
				const items = yield* runtimeStore.items(chat, { turn: delivery.turn! })
				assert.match(JSON.stringify(items), /ran:echo-1/)
				assert.equal(HashMap.size(ChatState.unansweredCalls(items)), 0)
			}),
		).pipe(Effect.provide(Layer.merge(approvalModel(prompts), counted(calls)))),
	)
})

test(
	"interrupt keeps an external receipt while another tool is still running",
	{ timeout: 5000 },
	async () => {
		const Slow = Tool.make("Slow", {
			parameters: Schema.Struct({}),
			success: Schema.String,
		})
		const concurrent = Toolkit.make(Echo, Slow)
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
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
					assert.equal(Chat.currentTurn(view.chat)!.status._tag, "Interrupted")
					assert.equal(view.state.conversation.closed, true)
					const items = yield* runtimeStore.items(chat)
					assert.match(JSON.stringify(items), /actual external receipt/)
					assert.equal(HashMap.size(ChatState.unansweredCalls(items)), 0)
				}),
			).pipe(
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
			),
		)
	},
)

test("an activity wait wakes after the final resources are released, without a new revision", async () => {
	await Effect.runPromise(
		Effect.scoped(
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
				assert.equal(delivery.delivery, "started")
				yield* Deferred.await(entered)
				yield* Effect.gen(function* () {
					const completed = yield* runtimeStore.read(chat)
					assert.equal(Chat.status(completed.chat)._tag, "Completed")
					assert.equal(yield* runtime.isActive(chat), true)
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
					const woken = yield* Fiber.join(waiting).pipe(
						Effect.timeout("500 millis"),
					)
					assert.equal(woken.chat.revision, completed.chat.revision)
					assert.equal(yield* runtime.isActive(chat), false)
					yield* runtime
						.wait({
							chat,
							after: woken.chat.revision,
							afterActive: true,
							timeout: "5 seconds",
						})
						.pipe(Effect.timeout("500 millis"))
				}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
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
