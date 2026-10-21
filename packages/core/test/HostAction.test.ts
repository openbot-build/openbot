// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import {
	MemoryPersistence,
	Session,
	SessionRuntime,
	SessionStoreRepository,
	Store,
} from "@openbot-build/core"
import { Deferred, Effect, Match, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import * as TimelineState from "../src/timeline/TimelineState.ts"

test("host-selected actions check and approve the exact parameters without the model, and cannot reuse an approval from history", async () => {
	let calls: ReadonlyArray<string> = []
	const write = Tool.make("Write", {
		parameters: Schema.Struct({ text: Schema.String }),
		success: Schema.String,
		needsApproval: true,
	})
	const toolkit = Toolkit.make(write)
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const definition = yield* Store.define({
					stores: {},
					schemaVersion: "host-action/1",
				})
				const store = yield* SessionStoreRepository.make({
					definition,
					persistence: yield* MemoryPersistence.make,
				})
				const runtime = yield* SessionRuntime.make({
					store,
					agent: {
						toolkit,
						modelCatalog: Effect.die(
							"Host actions must not load a model catalog",
						),
					},
				})
				const session = yield* store.create({
					metadata: {},
					value: TimelineState.initial({}),
				})
				const settled = () =>
					Effect.gen(function* () {
						let view = yield* store.read(session.session.id)
						for (let index = 0; index < 30; index++) {
							const active = yield* runtime.isActive(view.session.id)
							if (
								!active &&
								Session.currentTurn(view.session)?.status._tag !== "Running"
							)
								return view
							view = yield* runtime.wait({
								session: view.session.id,
								after: view.session.revision,
								afterActive: active,
								timeout: 1000,
							})
						}
						return yield* Effect.die("The host action did not stop running")
					})
				const receipt = yield* runtime.startAction({
					base: {
						session: session.session.id,
						revision: session.session.revision,
					},
					action: {
						name: "Write",
						arguments: { text: "Exact host selection" },
						source: { surface: "test" },
					},
				})
				const pending = yield* settled()
				assert.equal(calls.length, 0)
				assert.equal(
					Session.currentTurn(pending.session)?.status._tag,
					"Waiting",
				)
				assert.deepEqual(
					Session.currentTurn(pending.session)?.action?.arguments,
					{ text: "Exact host selection" },
				)
				const request = pending.state.value.conversation.context.prompt.content
					.flatMap((message) =>
						Match.value(message).pipe(
							Match.when({ role: "assistant" }, (message) =>
								message.content.filter(
									(part) => part.type === "tool-approval-request",
								),
							),
							Match.orElse(() => []),
						),
					)
					.find((part) => part.type === "tool-approval-request")
				assert.ok(request)
				const busy = yield* Effect.result(
					runtime.startAction({
						base: {
							session: session.session.id,
							revision: pending.session.revision,
						},
						action: {
							name: "Write",
							arguments: { text: "Unapproved replacement" },
						},
					}),
				)
				assert.equal(busy._tag, "Failure")
				const restored = yield* SessionRuntime.make({
					store,
					agent: { toolkit },
				})
				// A new runtime over the same store can answer, as after a restart.
				yield* restored.resolveAction({
					session: session.session.id,
					turn: receipt.turn,
					approval: request.approvalId,
					outcome: Session.Outcome.Approved(),
					expectedRevision: pending.session.revision,
				})
				const completed = yield* settled()
				assert.equal(
					Session.currentTurn(completed.session)?.status._tag,
					"Completed",
				)
				assert.deepEqual(calls, ["Exact host selection"])
				assert.match(
					JSON.stringify(completed.state.value.conversation.history),
					/Actual receipt: Exact host selection/,
				)
				assert.equal(
					Session.currentTurn(completed.session)?.usage?.length ?? 0,
					0,
				)
				const invalid = yield* runtime.startAction({
					base: {
						session: session.session.id,
						revision: completed.session.revision,
					},
					action: { name: "Write", arguments: { text: 17 } },
				})
				assert.notEqual(invalid.turn, receipt.turn)
				yield* settled()
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

test("host actions share cancellation and admission, and independent Sessions keep running", async () => {
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
				const definition = yield* Store.define({
					stores: {},
					schemaVersion: "host-action/1",
				})
				const store = yield* SessionStoreRepository.make({
					definition,
					persistence: yield* MemoryPersistence.make,
				})
				const runtime = yield* SessionRuntime.make({
					store,
					agent: { toolkit },
				})
				const first = yield* store.create({
					metadata: {},
					value: TimelineState.initial({}),
				})
				const second = yield* store.create({
					metadata: {},
					value: TimelineState.initial({}),
				})
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
						base: {
							session: first.session.id,
							revision: first.session.revision,
						},
						action: { name: "Gate", arguments: { hold: true } },
					})
					.pipe(Effect.provideContext(handlers))
				yield* Deferred.await(entered)
				const other = yield* runtime
					.startAction({
						base: {
							session: second.session.id,
							revision: second.session.revision,
						},
						action: { name: "Gate", arguments: { hold: false } },
					})
					.pipe(Effect.provideContext(handlers))
				assert.notEqual(held.turn, other.turn)
				const stopped = yield* runtime.interrupt({
					session: held.session,
					turn: held.turn,
				})
				yield* Deferred.await(released)
				assert.equal(
					Session.currentTurn(stopped.session)?.status._tag,
					"Interrupted",
				)
				let view = yield* store.read(second.session.id)
				for (
					let index = 0;
					index < 30 && (yield* runtime.isActive(second.session.id));
					index++
				)
					view = yield* runtime.wait({
						session: second.session.id,
						after: view.session.revision,
						afterActive: true,
						timeout: 1000,
					})
				assert.equal(
					Session.currentTurn(view.session)?.status._tag,
					"Completed",
				)
				assert.match(
					JSON.stringify(view.state.value.conversation.history),
					/Independent receipt/,
				)
			}),
		),
	)
})

test("a related host action waits in the active Turn and keeps its own approval and Item", async () => {
	let writes = 0
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
				const definition = yield* Store.define({
					stores: {},
					schemaVersion: "host-action/1",
				})
				const store = yield* SessionStoreRepository.make({
					definition,
					persistence: yield* MemoryPersistence.make,
				})
				const runtime = yield* SessionRuntime.make({
					store,
					agent: { toolkit },
				})
				const view = yield* store.create({
					metadata: {},
					value: TimelineState.initial({}),
				})
				const original = yield* runtime
					.startAction({
						base: { session: view.session.id, revision: view.session.revision },
						action: { name: "Gate", arguments: {} },
					})
					.pipe(Effect.provideContext(handlers))
				yield* Deferred.await(entered)
				const running = yield* store.read(view.session.id)
				const related = yield* runtime
					.startAction({
						base: {
							session: view.session.id,
							revision: running.session.revision,
						},
						turn: original.turn,
						action: {
							name: "Write",
							arguments: { text: "Specific selection" },
						},
					})
					.pipe(Effect.provideContext(handlers))
				assert.equal(related.turn, original.turn)
				assert.notEqual(related.item, original.item)
				assert.equal(writes, 0)
				yield* Deferred.succeed(release, undefined)
				let pending = yield* store.read(view.session.id)
				for (let index = 0; index < 30; index++) {
					const active = yield* runtime.isActive(view.session.id)
					if (
						!active &&
						Session.currentTurn(pending.session)?.status._tag === "Waiting"
					)
						break
					pending = yield* runtime.wait({
						session: view.session.id,
						after: pending.session.revision,
						afterActive: active,
						timeout: 1000,
					})
				}
				assert.equal(
					Session.currentTurn(pending.session)?.status._tag,
					"Waiting",
				)
				assert.equal(
					Session.currentTurn(pending.session)?.activeAction?.item,
					related.item,
				)
				const request = pending.state.value.conversation.context.prompt.content
					.flatMap((message) =>
						Match.value(message).pipe(
							Match.when({ role: "assistant" }, (message) =>
								message.content.filter(
									(part) => part.type === "tool-approval-request",
								),
							),
							Match.orElse(() => []),
						),
					)
					.find((part) => part.type === "tool-approval-request")
				assert.ok(request)
				assert.equal(request.toolCallId, related.callId)
				yield* runtime
					.resolveAction({
						session: view.session.id,
						turn: related.turn,
						approval: request.approvalId,
						outcome: Session.Outcome.Approved(),
						expectedRevision: pending.session.revision,
					})
					.pipe(Effect.provideContext(handlers))
				let completed = yield* store.read(view.session.id)
				for (
					let index = 0;
					index < 30 && (yield* runtime.isActive(view.session.id));
					index++
				)
					completed = yield* runtime.wait({
						session: view.session.id,
						after: completed.session.revision,
						afterActive: true,
						timeout: 1000,
					})
				assert.equal(
					Session.currentTurn(completed.session)?.status._tag,
					"Completed",
				)
				assert.equal(
					Session.currentTurn(completed.session)?.activeAction,
					undefined,
				)
				assert.equal(writes, 1)
				assert.match(
					JSON.stringify(completed.state.value.conversation.history),
					/Related receipt: Specific selection/,
				)
			}),
		),
	)
})
