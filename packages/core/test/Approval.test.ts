// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import {
	Effect,
	Exit,
	HashSet,
	Layer,
	Match,
	Option,
	Schema,
	Stream,
} from "effect"
import { LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/ai"
import {
	ContextWindow,
	Item,
	TimelineState,
	Session,
	SessionRuntime,
	SessionStoreMemory,
	type SessionStore,
} from "@openbot-build/core"
import { SessionTest } from "./SessionTest.ts"
import {
	LanguageModelTest,
	finish,
	lastText,
	textParts,
} from "./LanguageModelTest.ts"

const Write = Tool.make("Write", {
	parameters: Schema.Struct({}),
	success: Schema.String,
	needsApproval: true,
})
const toolkit = Toolkit.make(Write)
const approval = (view: Session.View) =>
	view.state.value.conversation.context.prompt.content
		.flatMap((message) =>
			Match.value(message).pipe(
				Match.when({ role: "assistant" }, (message) =>
					message.content.flatMap((part) =>
						Match.value(part).pipe(
							Match.when({ type: "tool-approval-request" }, (part) => [
								part.approvalId,
							]),
							Match.orElse(() => []),
						),
					),
				),
				Match.orElse(() => []),
			),
		)
		.at(-1)!
const results = (prompt: Prompt.Prompt) =>
	prompt.content.flatMap((message) =>
		Match.value(message).pipe(
			Match.when({ role: "tool" }, (message) =>
				message.content.filter((part) => part.type === "tool-result"),
			),
			Match.orElse(() => []),
		),
	)
const appendMemory = (
	store: SessionStore.Store<{}>,
	session: Session.Id,
	input: {
		readonly history: ReadonlyArray<Item.Record>
		readonly context: Prompt.Prompt
	},
) =>
	store.modifyEffect({
		session,
		update: (view) =>
			Effect.succeed([
				undefined,
				Option.some({
					value: {
						...view.state.value,
						conversation: {
							...view.state.value.conversation,
							history: [
								...view.state.value.conversation.history,
								...input.history,
							],
							context: ContextWindow.append(
								view.state.value.conversation.context,
								input.context,
							),
						},
					},
				}),
			]),
	})

const historical = (name = "Write", approved = false) =>
	Prompt.make([
		{
			role: "assistant",
			content: [
				{
					type: "tool-call",
					id: "historical-write",
					name,
					params: {},
					providerExecuted: false,
				},
				{
					type: "tool-approval-request",
					approvalId: "historical-approval",
					toolCallId: "historical-write",
				},
			],
		},
		...(approved
			? [
					{
						role: "tool" as const,
						content: [
							Prompt.toolApprovalResponsePart({
								approvalId: "historical-approval",
								approved: true,
							}),
						],
					},
				]
			: []),
	])

for (const origin of ["earlier Turn", "other Session", "missing provenance"]) {
	test(`core rejects an approval from ${origin} without changing the current Turn`, async () => {
		let writes = 0
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { runtime, runtimeStore, base } = yield* SessionTest({
						toolkit,
					})
					const first = yield* runtime.execute({ base, input: "seed" })
					const prior = Session.currentTurn(first.session)!
					const waiting = yield* runtime.execute({
						base: { session: base.session, revision: first.session.revision },
						input: "write",
					})
					const current = Session.currentTurn(waiting.session)!
					const currentApproval = approval(waiting)
					const stale = historical()
					const injected = yield* runtimeStore.modifyEffect({
						session: base.session,
						update: (view) =>
							Effect.succeed([
								undefined,
								Option.some({
									value: {
										...view.state.value,
										conversation: {
											...view.state.value.conversation,
											history: [
												...view.state.value.conversation.history,
												{
													id: Item.Id.make("stale-approval"),
													content: stale,
													...(origin === "missing provenance"
														? {}
														: {
																origin: {
																	session:
																		origin === "other Session"
																			? Session.Id.make("another-session")
																			: base.session,
																	turn:
																		origin === "earlier Turn"
																			? prior.id
																			: current.id,
																	step: 0,
																},
															}),
												},
											],
											context: ContextWindow.append(
												view.state.value.conversation.context,
												stale,
											),
										},
									},
								}),
							]),
					})
					const rejected = yield* Effect.exit(
						runtime.resolve({
							session: base.session,
							turn: current.id,
							approval: "historical-approval",
							outcome: { _tag: true ? "Approved" : "Denied" },
							expectedRevision: injected.view.session.revision,
						}),
					)
					assert.ok(Exit.isFailure(rejected))
					assert.equal(
						(yield* runtimeStore.read(base.session)).session.revision,
						injected.view.session.revision,
					)
					assert.equal(writes, 0)
					yield* runtime.interrupt({ session: base.session, turn: current.id })
					assert.equal(writes, 0)
					assert.notEqual(currentApproval, "historical-approval")
				}),
			).pipe(
				Effect.provide(
					Layer.merge(
						toolkit.toLayer({
							Write: () =>
								Effect.sync(() => {
									writes++
									return "written"
								}),
						}),
						LanguageModelTest({
							streamText: ({ prompt }) =>
								lastText(prompt) === "seed"
									? Stream.fromArray(textParts("seeded"))
									: Stream.make(
											Response.makePart("tool-call", {
												id: "current-write",
												name: "Write",
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
	})
}

for (const name of ["Write", "RemovedWrite"]) {
	test(`a new Turn closes an approved historical ${name} without replaying it`, async () => {
		let writes = 0
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { runtime, runtimeStore, base } = yield* SessionTest({
						toolkit,
					})
					const first = yield* runtime.execute({ base, input: "seed" })
					const previous = Session.currentTurn(first.session)!
					const stale = historical(name, true)
					const injected = yield* runtimeStore.modifyEffect({
						session: base.session,
						update: (view) =>
							Effect.succeed([
								undefined,
								Option.some({
									value: {
										...view.state.value,
										conversation: {
											...view.state.value.conversation,
											history: [
												...view.state.value.conversation.history,
												{
													id: Item.Id.make("historical-approved"),
													content: stale,
													origin: {
														session: base.session,
														turn: previous.id,
														step: 0,
													},
												},
											],
											context: ContextWindow.append(
												view.state.value.conversation.context,
												stale,
											),
										},
									},
								}),
							]),
					})
					const next = yield* runtime.execute({
						base: {
							session: base.session,
							revision: injected.view.session.revision,
						},
						input: "continue",
					})
					assert.equal(Session.status(next.session)._tag, "Completed")
					assert.equal(writes, 0)
					assert.equal(
						results(next.state.value.conversation.context.prompt).find(
							(part) => part.id === "historical-write",
						)?.isFailure,
						true,
					)
					assert.equal(TimelineState.coherent(next.state.value), true)
				}),
			).pipe(
				Effect.provide(
					Layer.merge(
						toolkit.toLayer({
							Write: () =>
								Effect.sync(() => {
									writes++
									return "written"
								}),
						}),
						LanguageModelTest({
							streamText: () => Stream.fromArray(textParts("done")),
						}),
					),
				),
			),
		)
	})
}

test("new Turn restores a known historical result missing from the context without another write", async () => {
	let writes = 0
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { runtime, runtimeStore, base } = yield* SessionTest({ toolkit })
				const first = yield* runtime.execute({ base, input: "seed" })
				const prior = Session.currentTurn(first.session)!
				const stale = historical("Write", true)
				const settled = Prompt.concat(
					stale,
					Prompt.make([
						{
							role: "tool",
							content: [
								Prompt.toolResultPart({
									id: "historical-write",
									name: "Write",
									isFailure: false,
									result: "original-receipt",
									providerExecuted: false,
								}),
							],
						},
					]),
				)
				const injected = yield* appendMemory(runtimeStore, base.session, {
					history: [
						{
							id: Item.Id.make("known-historical-result"),
							content: settled,
							origin: { session: base.session, turn: prior.id, step: 0 },
						},
					],
					context: stale,
				})
				const next = yield* runtime.execute({
					base: {
						session: base.session,
						revision: injected.view.session.revision,
					},
					input: "continue",
				})
				assert.equal(writes, 0)
				assert.equal(
					results(next.state.value.conversation.context.prompt).find(
						(part) => part.id === "historical-write",
					)?.result,
					"original-receipt",
				)
				assert.equal(
					results(TimelineState.fullHistory(next.state.value)).filter(
						(part) => part.id === "historical-write",
					).length,
					1,
				)
			}),
		).pipe(
			Effect.provide(
				Layer.merge(
					toolkit.toLayer({
						Write: () =>
							Effect.sync(() => {
								writes++
								return "unexpected duplicate"
							}),
					}),
					LanguageModelTest({
						streamText: () => Stream.fromArray(textParts("done")),
					}),
				),
			),
		),
	)
})

for (const location of ["context", "history"] as const) {
	test(`Resume closes a ${location}-only orphan without executing a historical write`, async () => {
		let writes = 0
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { runtime, runtimeStore, base } = yield* SessionTest({
						toolkit,
					})
					yield* runtime.execute({ base, input: "seed" })
					const stale = historical("Write", true)
					yield* runtimeStore.modifyEffect({
						session: base.session,
						update: (view) =>
							Effect.succeed([
								undefined,
								Option.some({
									value: {
										...view.state.value,
										conversation: {
											...view.state.value.conversation,
											history:
												location === "history"
													? [
															...view.state.value.conversation.history,
															{
																id: Item.Id.make("orphaned-history"),
																content: stale,
															},
														]
													: view.state.value.conversation.history,
											context:
												location === "context"
													? ContextWindow.append(
															view.state.value.conversation.context,
															stale,
														)
													: view.state.value.conversation.context,
										},
									},
								}),
							]),
					})
					const resumed = yield* runtime.resume(base.session)
					const observed =
						location === "context"
							? resumed.state.value.conversation.context.prompt
							: TimelineState.fullHistory(resumed.state.value)
					assert.equal(
						results(observed).find((part) => part.id === "historical-write")
							?.isFailure,
						true,
					)
					assert.equal(TimelineState.coherent(resumed.state.value), true)
					assert.equal(writes, 0)
					assert.equal(
						(yield* runtime.resume(base.session)).session.revision,
						resumed.session.revision,
					)
				}),
			).pipe(
				Effect.provide(
					Layer.merge(
						toolkit.toLayer({
							Write: () =>
								Effect.sync(() => {
									writes++
									return "must not run"
								}),
						}),
						LanguageModelTest({
							streamText: () => Stream.fromArray(textParts("done")),
						}),
					),
				),
			),
		)
	})
}

test("restoring a waiting Turn preserves its durable approval and interruption closes orphan context", async () => {
	let writes = 0
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { runtime, runtimeStore, base, definition } = yield* SessionTest({
					toolkit,
				})
				yield* runtime.execute({ base, input: "write" })
				yield* runtimeStore.modifyEffect({
					session: base.session,
					update: (view) =>
						Effect.succeed([
							undefined,
							Option.some({
								value: {
									...view.state.value,
									conversation: {
										...view.state.value.conversation,
										context: ContextWindow.append(
											view.state.value.conversation.context,
											historical("RemovedWrite", true),
										),
									},
								},
							}),
						]),
				})
				const restoredStore = yield* SessionStoreMemory.make(definition)
				yield* restoredStore.import({
					record: yield* runtimeStore.export(base.session),
					expected: null,
				})
				const restored = yield* SessionRuntime.make({
					store: restoredStore,
					agent: { toolkit },
				})
				const waiting = yield* restored.resume(base.session)
				assert.equal(Session.status(waiting.session)._tag, "Waiting")
				assert.deepEqual(
					Session.waits(waiting).map((wait) => wait.toolCallId),
					["current-write"],
				)
				assert.equal(writes, 0)
				const resumed = yield* restored.interrupt({
					session: base.session,
					turn: Session.currentTurn(waiting.session)!.id,
				})
				assert.equal(Session.status(resumed.session)._tag, "Interrupted")
				assert.equal(
					results(resumed.state.value.conversation.context.prompt).find(
						(part) => part.id === "historical-write",
					)?.isFailure,
					true,
				)
				assert.deepEqual(Session.waits(resumed), [])
				assert.equal(writes, 0)
			}),
		).pipe(
			Effect.provide(
				Layer.merge(
					toolkit.toLayer({
						Write: () =>
							Effect.sync(() => {
								writes++
								return "must not run"
							}),
					}),
					LanguageModelTest({
						streamText: () =>
							Stream.make(
								Response.makePart("tool-call", {
									id: "current-write",
									name: "Write",
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
})

for (const decision of [true, false]) {
	test(`current approval remains usable with approved=${decision}`, async () => {
		let writes = 0
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { runtime, runtimeStore, base } = yield* SessionTest({
						toolkit,
					})
					const waiting = yield* runtime.execute({ base, input: "write" })
					const current = Session.currentTurn(waiting.session)!
					const [request] = Session.waits(waiting)
					assert.ok(request)
					yield* runtime.resolve({
						session: base.session,
						turn: current.id,
						approval: request.approvalId,
						outcome: { _tag: decision ? "Approved" : "Denied" },
						expectedRevision: waiting.session.revision,
					})
					const settled = (): Effect.Effect<
						Session.View,
						Session.RuntimeError
					> =>
						Effect.gen(function* () {
							if (yield* runtime.isActive(base.session)) {
								yield* Effect.yieldNow
								return yield* settled()
							}
							return yield* runtimeStore.read(base.session)
						})
					const ended = yield* settled()
					assert.equal(Session.status(ended.session)._tag, "Completed")
					assert.equal(writes, decision ? 1 : 0)
					assert.deepEqual(Session.waits(ended), [])
				}),
			).pipe(
				Effect.provide(
					Layer.merge(
						toolkit.toLayer({
							Write: () =>
								Effect.sync(() => {
									writes++
									return "written"
								}),
						}),
						LanguageModelTest({
							streamText: ({ prompt }) =>
								results(prompt).length > 0
									? Stream.fromArray(textParts("done"))
									: Stream.make(
											Response.makePart("tool-call", {
												id: "current-write",
												name: "Write",
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
	})
}

test("a known context result fills an unfinished history entry without replay or loss", async () => {
	let writes = 0
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { runtime, runtimeStore, base } = yield* SessionTest({ toolkit })
				const first = yield* runtime.execute({ base, input: "seed" })
				const prior = Session.currentTurn(first.session)!
				const stale = historical("Write", true)
				const settled = Prompt.concat(
					stale,
					Prompt.make([
						{
							role: "tool",
							content: [
								Prompt.toolResultPart({
									id: "historical-write",
									name: "Write",
									isFailure: false,
									result: "original-context-receipt",
									providerExecuted: false,
								}),
							],
						},
					]),
				)
				const injected = yield* appendMemory(runtimeStore, base.session, {
					history: [
						{
							id: Item.Id.make("history-missing-result"),
							content: stale,
							origin: { session: base.session, turn: prior.id, step: 0 },
						},
					],
					context: settled,
				})
				const next = yield* runtime.execute({
					base: {
						session: base.session,
						revision: injected.view.session.revision,
					},
					input: "continue",
				})
				assert.equal(writes, 0)
				for (const prompt of [
					TimelineState.fullHistory(next.state.value),
					next.state.value.conversation.context.prompt,
				]) {
					const saved = results(prompt).filter(
						(part) => part.id === "historical-write",
					)
					assert.equal(saved.length, 1)
					assert.equal(saved[0]?.isFailure, false)
					assert.equal(saved[0]?.result, "original-context-receipt")
				}
			}),
		).pipe(
			Effect.provide(
				Layer.merge(
					toolkit.toLayer({
						Write: () =>
							Effect.sync(() => {
								writes++
								return "unexpected duplicate"
							}),
					}),
					LanguageModelTest({
						streamText: () => Stream.fromArray(textParts("done")),
					}),
				),
			),
		),
	)
})

for (const firstApproved of [true, false]) {
	for (const secondApproved of [true, false]) {
		test(`reused call IDs execute only their own decision (${firstApproved}, ${secondApproved})`, async () => {
			const Write = Tool.make("Write", {
				parameters: Schema.Struct({ sequence: Schema.Finite }),
				success: Schema.Finite,
				needsApproval: true,
			})
			const tools = Toolkit.make(Write)
			let writes: ReadonlyArray<number> = []
			let emitted = HashSet.empty<string>()
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const { runtime, runtimeStore, base } = yield* SessionTest({
							toolkit: tools,
						})
						let revision = base.revision
						for (const [index, approved] of [
							firstApproved,
							secondApproved,
						].entries()) {
							const sequence = index + 1
							const waiting = yield* runtime.execute({
								base: { session: base.session, revision },
								input: String(sequence),
							})
							const turn = Session.currentTurn(waiting.session)!
							const pending = Session.waits(waiting)
							assert.equal(pending.length, 1)
							assert.deepEqual(pending[0]?.toolCall.params, { sequence })
							yield* runtime.resolve({
								session: base.session,
								turn: turn.id,
								approval: pending[0]!.approvalId,
								outcome: { _tag: approved ? "Approved" : "Denied" },
								expectedRevision: waiting.session.revision,
							})
							const settled = (): Effect.Effect<
								Session.View,
								Session.RuntimeError
							> =>
								Effect.gen(function* () {
									if (yield* runtime.isActive(base.session)) {
										yield* Effect.yieldNow
										return yield* settled()
									}
									return yield* runtimeStore.read(base.session)
								})
							const ended = yield* settled()
							const currentResults = results(
								Prompt.fromMessages(
									ended.state.value.conversation.history
										.filter((item) => item.origin?.turn === turn.id)
										.flatMap((item) => item.content.content),
								),
							)
							assert.equal(
								currentResults.length,
								1,
								"Each decision must produce its own tool result without a second model call",
							)
							assert.equal(currentResults[0]?.id, "reused")
							assert.equal(currentResults[0]?.isFailure, !approved)
							if (approved) assert.equal(currentResults[0]?.result, sequence)
							assert.deepEqual(
								writes,
								[
									firstApproved ? 1 : undefined,
									...(index === 1 ? [secondApproved ? 2 : undefined] : []),
								].filter((value) => value !== undefined),
							)
							assert.equal(Session.status(ended.session)._tag, "Completed")
							revision = ended.session.revision
						}
					}),
				).pipe(
					Effect.provide(
						Layer.merge(
							tools.toLayer({
								Write: ({ sequence }) =>
									Effect.sync(() => {
										writes = [...writes, sequence]
										return sequence
									}),
							}),
							LanguageModelTest({
								streamText: ({ prompt }) => {
									const input = lastText(prompt)
									if (HashSet.has(emitted, input))
										return Stream.fromArray(textParts("done"))
									emitted = HashSet.add(emitted, input)
									return Stream.make(
										Response.makePart("tool-call", {
											id: "reused",
											name: "Write",
											params: { sequence: Number(input) },
											providerExecuted: false,
										}),
										finish("tool-calls"),
									)
								},
							}),
						),
					),
				),
			)
		})
	}
}

for (const missing of ["history", "context"] as const) {
	test(`Resume does not copy a different occurrence's receipt into ${missing}`, async () => {
		let writes = 0
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { runtime, runtimeStore, base } = yield* SessionTest({
						toolkit,
					})
					const first = yield* runtime.execute({ base, input: "first" })
					const second = yield* runtime.execute({
						base: { session: base.session, revision: first.session.revision },
						input: "second",
					})
					const call = Prompt.make([
						{
							role: "assistant",
							content: [
								Prompt.toolCallPart({
									id: "reused",
									name: "Write",
									params: {},
									providerExecuted: false,
								}),
							],
						},
					])
					const known = Prompt.concat(
						call,
						Prompt.make([
							{
								role: "tool",
								content: [
									Prompt.toolResultPart({
										id: "reused",
										name: "Write",
										result: "old-receipt",
										isFailure: false,
										providerExecuted: false,
									}),
								],
							},
						]),
					)
					yield* appendMemory(runtimeStore, base.session, {
						history: [
							{
								id: Item.Id.make("known"),
								content: known,
								origin: {
									session: base.session,
									turn: Session.currentTurn(first.session)!.id,
									step: 1,
								},
							},
							...(missing === "history"
								? [
										{
											id: Item.Id.make("unknown"),
											content: call,
											origin: {
												session: base.session,
												turn: Session.currentTurn(second.session)!.id,
												step: 1,
											},
										},
									]
								: []),
						],
						context: missing === "context" ? Prompt.concat(known, call) : known,
					})
					const resumed = yield* runtime.resume(base.session)
					const observed = results(
						missing === "history"
							? TimelineState.fullHistory(resumed.state.value)
							: resumed.state.value.conversation.context.prompt,
					)
					assert.equal(observed.length, 2)
					assert.equal(observed[0]?.result, "old-receipt")
					assert.equal(observed[1]?.id, "reused")
					assert.equal(observed[1]?.isFailure, true)
					assert.match(String(observed[1]?.result), /unavailable/)
					assert.equal(writes, 0)
					assert.equal(
						(yield* runtime.resume(base.session)).session.revision,
						resumed.session.revision,
					)
				}),
			).pipe(
				Effect.provide(
					Layer.merge(
						toolkit.toLayer({
							Write: () =>
								Effect.sync(() => {
									writes++
									return "unexpected"
								}),
						}),
						LanguageModelTest({
							streamText: () => Stream.fromArray(textParts("done")),
						}),
					),
				),
			),
		)
	})
}

for (const mode of ["generate", "stream"] as const) {
	for (const oldSettled of [true, false]) {
		test(`${mode} approval resolution preserves occurrences when the old call is settled=${oldSettled}`, async () => {
			const Write = Tool.make("Write", {
				parameters: Schema.Struct({ sequence: Schema.Finite }),
				success: Schema.Finite,
				needsApproval: true,
			})
			const tools = Toolkit.make(Write)
			let writes: ReadonlyArray<number> = []
			const currentCall = Prompt.toolCallPart({
				id: "same-id",
				name: "Write",
				params: { sequence: 2 },
				providerExecuted: false,
			})
			const prompt = Prompt.make([
				{
					role: "assistant",
					content: [
						oldSettled
							? currentCall
							: Prompt.toolCallPart({
									id: "same-id",
									name: "Write",
									params: { sequence: 1 },
									providerExecuted: false,
								}),
						Prompt.toolApprovalRequestPart({
							approvalId: "old",
							toolCallId: "same-id",
						}),
					],
				},
				{
					role: "tool",
					content: [
						Prompt.toolApprovalResponsePart({
							approvalId: "old",
							approved: true,
						}),
						...(oldSettled
							? [
									Prompt.toolResultPart({
										id: "same-id",
										name: "Write",
										result: 2,
										isFailure: false,
										providerExecuted: false,
									}),
								]
							: []),
					],
				},
				{
					role: "assistant",
					content: [
						currentCall,
						Prompt.toolApprovalRequestPart({
							approvalId: "current",
							toolCallId: "same-id",
						}),
					],
				},
				{
					role: "tool",
					content: [
						Prompt.toolApprovalResponsePart({
							approvalId: "current",
							approved: true,
						}),
					],
				},
			])
			await Effect.runPromise(
				Effect.gen(function* () {
					const response =
						mode === "generate"
							? (yield* LanguageModel.generateText({ prompt, toolkit: tools }))
									.content
							: yield* LanguageModel.streamText({
									prompt,
									toolkit: tools,
								}).pipe(Stream.runCollect)
					const receipts = response.filter(
						(part) => part.type === "tool-result",
					)
					assert.equal(receipts.length, 1)
					assert.equal(receipts[0]?.id, "same-id")
					assert.equal(receipts[0]?.result, 2)
					assert.deepEqual(writes, [2])
				}).pipe(
					Effect.provide(
						Layer.merge(
							tools.toLayer({
								Write: ({ sequence }) =>
									Effect.sync(() => {
										writes = [...writes, sequence]
										return sequence
									}),
							}),
							LanguageModelTest({
								streamText: () => Stream.fromArray(textParts("done")),
							}),
						),
					),
				),
			)
		})
	}
}

for (const secondApproved of [true, false]) {
	for (const sameArguments of [true, false]) {
		test(`same Turn reused ID has an independent approval (approved=${secondApproved}, same arguments=${sameArguments})`, async () => {
			const Write = Tool.make("Write", {
				parameters: Schema.Struct({ sequence: Schema.Finite }),
				success: Schema.Finite,
				needsApproval: true,
			})
			const tools = Toolkit.make(Write)
			let writes: ReadonlyArray<number> = []
			let modelSteps = 0
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const { runtime, runtimeStore, base } = yield* SessionTest({
							toolkit: tools,
						})
						const first = yield* runtime.execute({
							base,
							input: "Perform two separately approved writes",
						})
						const turn = Session.currentTurn(first.session)!
						const old = Session.waits(first)[0]!
						const settled = (): Effect.Effect<
							Session.View,
							Session.RuntimeError
						> =>
							Effect.gen(function* () {
								if (yield* runtime.isActive(base.session)) {
									yield* Effect.yieldNow
									return yield* settled()
								}
								return yield* runtimeStore.read(base.session)
							})
						yield* runtime.resolve({
							session: base.session,
							turn: turn.id,
							approval: old.approvalId,
							outcome: { _tag: true ? "Approved" : "Denied" },
							expectedRevision: first.session.revision,
						})
						const second = yield* settled()
						assert.equal(Session.status(second.session)._tag, "Waiting")
						assert.equal(Session.currentTurn(second.session)?.id, turn.id)
						const requests = Session.waits(second)
						assert.equal(
							requests.length,
							1,
							"The new call must remain approvable after the old result",
						)
						const current = requests[0]!
						assert.notEqual(current.approvalId, old.approvalId)
						assert.equal(current.toolCallId, old.toolCallId)
						assert.deepEqual(current.toolCall.params, {
							sequence: sameArguments ? 1 : 2,
						})
						const rejected = yield* Effect.exit(
							runtime.resolve({
								session: base.session,
								turn: turn.id,
								approval: old.approvalId,
								outcome: { _tag: true ? "Approved" : "Denied" },
								expectedRevision: second.session.revision,
							}),
						)
						assert.ok(Exit.isFailure(rejected))
						assert.equal(
							(yield* runtimeStore.read(base.session)).session.revision,
							second.session.revision,
						)
						assert.deepEqual(writes, [1])
						yield* runtime.resolve({
							session: base.session,
							turn: turn.id,
							approval: current.approvalId,
							outcome: { _tag: secondApproved ? "Approved" : "Denied" },
							expectedRevision: second.session.revision,
						})
						const ended = yield* settled()
						assert.equal(Session.status(ended.session)._tag, "Completed")
						const receipts = results(
							TimelineState.fullHistory(ended.state.value),
						).filter((part) => part.id === "same-turn-id")
						assert.equal(receipts.length, 2)
						assert.equal(receipts[0]?.result, 1)
						assert.equal(receipts[1]?.isFailure, !secondApproved)
						if (secondApproved)
							assert.equal(receipts[1]?.result, sameArguments ? 1 : 2)
						assert.deepEqual(
							writes,
							secondApproved ? [1, sameArguments ? 1 : 2] : [1],
						)
						yield* runtime.resume(base.session)
						yield* runtime.execute({
							base: { session: base.session, revision: ended.session.revision },
							input: "Continue without another write",
						})
						assert.deepEqual(
							writes,
							secondApproved ? [1, sameArguments ? 1 : 2] : [1],
						)
					}),
				).pipe(
					Effect.provide(
						Layer.merge(
							tools.toLayer({
								Write: ({ sequence }) =>
									Effect.sync(() => {
										writes = [...writes, sequence]
										return sequence
									}),
							}),
							LanguageModelTest({
								streamText: () => {
									modelSteps++
									return modelSteps <= 2
										? Stream.make(
												Response.makePart("tool-call", {
													id: "same-turn-id",
													name: "Write",
													params: { sequence: sameArguments ? 1 : modelSteps },
													providerExecuted: false,
												}),
												finish("tool-calls"),
											)
										: Stream.fromArray(textParts("done"))
								},
							}),
						),
					),
				),
			)
		})
	}
}

for (const missing of ["history", "context"] as const) {
	for (const entry of ["resume", "input"] as const) {
		for (const ambiguous of [false, true]) {
			test(`earlier receipt recovery into ${missing} through ${entry} preserves unique=${!ambiguous}`, async () => {
				const Write = Tool.make("Write", {
					parameters: Schema.Struct({ sequence: Schema.Finite }),
					success: Schema.Struct({
						operationId: Schema.String,
						receipt: Schema.String,
					}),
					needsApproval: true,
				})
				const tools = Toolkit.make(Write)
				let writes = 0
				const call = (sequence: number, approvalId: string) =>
					Prompt.make([
						{
							role: "assistant",
							content: [
								Prompt.toolCallPart({
									id: "reused-history",
									name: "Write",
									params: { sequence },
									providerExecuted: false,
								}),
								Prompt.toolApprovalRequestPart({
									approvalId,
									toolCallId: "reused-history",
								}),
							],
						},
						{
							role: "tool",
							content: [
								Prompt.toolApprovalResponsePart({ approvalId, approved: true }),
							],
						},
					])
				const receipt = (operationId: string) =>
					Prompt.make([
						{
							role: "tool",
							content: [
								Prompt.toolResultPart({
									id: "reused-history",
									name: "Write",
									result: { operationId, receipt: "success" },
									isFailure: false,
									providerExecuted: false,
								}),
							],
						},
					])
				const first = call(1, "first-approval")
				const retained = Prompt.concat(
					Prompt.concat(first, receipt("first-operation")),
					Prompt.concat(
						ambiguous
							? Prompt.concat(
									call(1, "indistinguishable-approval"),
									receipt("another-operation"),
								)
							: Prompt.empty,
						Prompt.concat(
							call(2, "later-approval"),
							receipt("later-operation"),
						),
					),
				)
				await Effect.runPromise(
					Effect.scoped(
						Effect.gen(function* () {
							const { runtime, runtimeStore, base } = yield* SessionTest({
								toolkit: tools,
							})
							const seed = yield* runtime.execute({
								base,
								input: "Seed retained history",
							})
							const injected = yield* appendMemory(runtimeStore, base.session, {
								history: [
									{
										id: Item.Id.make("retained-receipts"),
										content: missing === "history" ? first : retained,
										origin: {
											session: base.session,
											turn: Session.currentTurn(seed.session)!.id,
											step: 1,
										},
									},
								],
								context: missing === "context" ? first : retained,
							})
							const repaired = yield* entry === "resume"
								? runtime.resume(base.session)
								: runtime.execute({
										base: {
											session: base.session,
											revision: injected.view.session.revision,
										},
										input: "Continue after recovery",
									})
							const repairedPrompt =
								missing === "history"
									? TimelineState.fullHistory(repaired.state.value)
									: repaired.state.value.conversation.context.prompt
							const restored = results(repairedPrompt).filter(
								(part) => part.id === "reused-history",
							)
							assert.equal(restored.length, 1)
							assert.equal(restored[0]?.name, "Write")
							assert.equal(restored[0]?.isFailure, ambiguous)
							if (ambiguous)
								assert.match(String(restored[0]?.result), /unavailable/)
							else
								assert.deepEqual(restored[0]?.result, {
									operationId: "first-operation",
									receipt: "success",
								})
							const source =
								missing === "history"
									? repaired.state.value.conversation.context.prompt
									: TimelineState.fullHistory(repaired.state.value)
							assert.deepEqual(
								results(source).map((part) => part.result),
								results(retained).map((part) => part.result),
							)
							assert.equal(writes, 0)
							const resumed = yield* runtime.resume(base.session)
							assert.equal(resumed.session.revision, repaired.session.revision)
							const continued = yield* runtime.execute({
								base: {
									session: base.session,
									revision: resumed.session.revision,
								},
								input: "Read the restored history without another write",
							})
							assert.equal(Session.status(continued.session)._tag, "Completed")
							assert.equal(writes, 0)
						}),
					).pipe(
						Effect.provide(
							Layer.merge(
								tools.toLayer({
									Write: () =>
										Effect.sync(() => {
											writes++
											return {
												operationId: "unexpected",
												receipt: "unexpected replay",
											}
										}),
								}),
								LanguageModelTest({
									streamText: () => Stream.fromArray(textParts("done")),
								}),
							),
						),
					),
				)
			})
		}
	}
}
