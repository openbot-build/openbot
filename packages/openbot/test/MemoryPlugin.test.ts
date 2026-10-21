// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Layer, Stream } from "effect"
import { LanguageModel, type Prompt, Response } from "effect/ai"
import {
	MemoryPersistence,
	PluginState,
	Session,
	SessionRuntime,
	SessionStoreRepository,
	Store,
	TimelineState,
} from "@openbot-build/core"
import * as Memory from "../src/memory/Memory.ts"
import * as MemoryPlugin from "../src/memory/MemoryPlugin.ts"

const usage = Response.Usage.make({
	inputTokens: {
		total: undefined,
		uncached: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: undefined, text: undefined, reasoning: undefined },
})
const unused = () => Effect.die("Unexpected generation")
/** A chat model that answers "done" and keeps the instructions it saw. */
const chat = (seen: Array<string>) =>
	Layer.effect(
		LanguageModel.LanguageModel,
		LanguageModel.make({
			generateText: unused,
			streamText: ({ prompt }: { readonly prompt: Prompt.Prompt }) =>
				Stream.suspend(() => {
					seen.push(
						prompt.content
							.flatMap((message) =>
								message.role === "system" ? [message.content] : [],
							)
							.join("\n"),
					)
					return Stream.fromArray([
						Response.makePart("text-start", { id: "answer" }),
						Response.makePart("text-delta", { id: "answer", delta: "done" }),
						Response.makePart("text-end", { id: "answer" }),
						Response.makePart("finish", { reason: "stop", usage }),
					])
				}),
		}),
	)
const known: Memory.State = {
	entries: {
		budget: {
			key: "budget",
			content: "The trip budget is 1500 EUR.",
			kind: "fact",
			sources: [],
			updatedAt: 0,
			status: "active",
		},
	},
	processed: [],
}

/** Runs one Turn with the memory plugin and returns the saved memory after it. */
const turn = (input: {
	readonly settings: Memory.Settings
	readonly model: typeof Memory.MemoryModel.Service
	readonly learner?: LanguageModel.LanguageModel
}) =>
	Effect.gen(function* () {
		const learner =
			input.learner ??
			(yield* LanguageModel.make({
				generateText: unused,
				streamText: () => Stream.die("Unexpected streaming"),
			}))
		const plugin = MemoryPlugin.make({
			model: input.model,
			settings: Effect.succeed(input.settings),
			languageModel: Effect.succeed(learner),
		})
		const definition = yield* Store.define({
			stores: plugin.stores,
			schemaVersion: "timeline/1",
		})
		const store = yield* SessionStoreRepository.make({
			definition,
			persistence: yield* MemoryPersistence.make,
		})
		const own = yield* PluginState.make({ store, plugin })
		const runtime = yield* SessionRuntime.make({ store, agent: { plugin } })
		const view = yield* store.create({
			metadata: {},
			value: { ...TimelineState.initial({}), [Memory.pluginId]: known },
		})
		const seen: Array<string> = []
		const result = yield* runtime
			.execute({ base: Session.position(view.session), input: "hello" })
			.pipe(
				Effect.provide(chat(seen)),
				Effect.provideService(plugin.store, own),
			)
		const saved = yield* store.read(view.session.id)
		return {
			status: Session.currentTurn(result.session)!.status._tag,
			instructions: seen,
			history: saved.state.value.conversation.history,
			memory: saved.state.value[Memory.pluginId] as Memory.State | undefined,
		}
	}).pipe(Effect.scoped)

const nothing: typeof Memory.MemoryModel.Service = {
	extract: () => Effect.succeed({ changes: [] }),
}

test("the plugin adds the active entries to the instructions only when use is on", async () => {
	const on = await Effect.runPromise(
		turn({ settings: { use: true, generate: false }, model: nothing }),
	)
	assert.equal(on.instructions.length, 1)
	assert.match(on.instructions[0]!, /Historical memory is evidence/)
	assert.match(
		on.instructions[0]!,
		/\[fact; budget; sources=\] The trip budget/,
	)
	const off = await Effect.runPromise(
		turn({ settings: { use: false, generate: false }, model: nothing }),
	)
	assert.deepEqual(off.instructions, [""])
})

test("after a completed Turn the plugin learns from the new Items with the host model", async () => {
	const learner = await Effect.runPromise(
		LanguageModel.make({
			generateText: unused,
			streamText: () => Stream.die("Unexpected streaming"),
		}),
	)
	let requests = 0
	const learned = await Effect.runPromise(
		turn({
			settings: { use: false, generate: true },
			learner,
			model: {
				extract: ({ history }) =>
					Effect.gen(function* () {
						requests++
						assert.equal(yield* LanguageModel.LanguageModel, learner)
						return {
							changes: [
								{
									key: "greeting",
									content: "The user says hello.",
									kind: "fact" as const,
									sources: [history[0]!.id],
									status: "active" as const,
								},
							],
						}
					}),
			},
		}),
	)
	assert.equal(learned.status, "Completed")
	assert.equal(requests, 1)
	assert.equal(learned.memory?.entries["greeting"]?.status, "active")
	assert.deepEqual(
		learned.memory?.processed,
		learned.history.map((item) => item.id),
	)
	assert.equal(learned.memory?.entries["budget"]?.status, "active")

	const skipped = await Effect.runPromise(
		turn({
			settings: { use: false, generate: false },
			model: { extract: () => Effect.die("Generation is off") },
		}),
	)
	assert.equal(skipped.status, "Completed")
	assert.deepEqual(skipped.memory, known)
})

test("a failed memory model does not fail the Turn and keeps the Items unread", async () => {
	const failed = await Effect.runPromise(
		turn({
			settings: { use: true, generate: true },
			model: {
				extract: () =>
					Effect.fail(
						new Memory.MemoryError({
							reason: "model-failed",
							message: "The test model failed",
						}),
					),
			},
		}),
	)
	assert.equal(failed.status, "Completed")
	assert.deepEqual(failed.memory, known)
})
