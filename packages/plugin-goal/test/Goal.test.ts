// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Exit, Layer, Match, Stream } from "effect"
import { LanguageModel, Prompt, Response } from "effect/ai"
import { Goal, GoalPlugin } from "@openbot-build/plugin-goal"
import {
	MemoryPersistence,
	PluginState,
	Session,
	SessionRuntime,
	SessionStoreRepository,
	Store,
} from "@openbot-build/core"
const usage = Response.Usage.make({
	inputTokens: {
		total: undefined,
		uncached: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: undefined, text: undefined, reasoning: undefined },
})
const finish = (reason: Response.FinishReason) =>
	Response.makePart("finish", { reason, usage })
const model = (
	respond: (prompt: Prompt.Prompt) => ReadonlyArray<Response.StreamPartEncoded>,
) =>
	Layer.effect(
		LanguageModel.LanguageModel,
		LanguageModel.make({
			generateText: () => Effect.succeed([]),
			streamText: ({ prompt }) =>
				Stream.suspend(() => Stream.fromArray(respond(prompt))),
		}),
	)
const setup = Effect.gen(function* () {
	const plugin = GoalPlugin.make(),
		definition = yield* Store.define({
			stores: plugin.stores,
			schemaVersion: "memory/1",
		})
	const store = yield* SessionStoreRepository.make({
		definition,
		persistence: yield* MemoryPersistence.make,
	})
	const own = yield* PluginState.make({ store, plugin }),
		runtime = yield* SessionRuntime.make({ store, agent: { plugin } })
	const view = yield* store.create({
		metadata: {},
	})
	const handlers = GoalPlugin.layer.pipe(
		Layer.provide(Layer.succeed(plugin.store, own)),
	)
	return { store, own, runtime, view, handlers }
})
const calls = (prompt: Prompt.Prompt) =>
	prompt.content.flatMap((message) =>
		Match.value(message).pipe(
			Match.when({ role: "tool" }, (message) =>
				message.content.filter((part) => part.type === "tool-result"),
			),
			Match.orElse(() => []),
		),
	)

test("six native handlers bind Goal values to the current Session and keep them out of Memory", async () => {
	const plans = [
		{ name: "GetGoal", params: {} },
		{ name: "SetGoal", params: { objective: "finish", tokenBudget: 100 } },
		{ name: "UpdateGoal", params: { objective: "revised" } },
		{ name: "PauseGoal", params: {} },
		{ name: "ResumeGoal", params: {} },
		{ name: "ClearGoal", params: {} },
		{ name: "GetGoal", params: {} },
	]
	let requests = 0
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { runtime, store, view, handlers } = yield* setup
				const layer = model((prompt) => {
					requests++
					const results = calls(prompt)
					assert.ok(results.every((result) => !result.isFailure))
					if (results.length > 1 && results.length < 6) {
						const result = results.at(-1)!.result
						assert.ok(
							typeof result === "object" &&
								result !== null &&
								"session" in result,
						)
						assert.equal(result.session, view.session.id)
					}
					const plan = plans[results.length]
					return plan === undefined
						? [
								Response.makePart("text-start", { id: "answer" }),
								Response.makePart("text-delta", {
									id: "answer",
									delta: "done",
								}),
								Response.makePart("text-end", { id: "answer" }),
								finish("stop"),
							]
						: [
								Response.makePart("tool-call", {
									id: `call-${results.length}`,
									name: plan.name,
									params: plan.params,
									providerExecuted: false,
								}),
								finish("tool-calls"),
							]
				})
				const result = yield* runtime
					.execute({
						base: { session: view.session.id, revision: view.session.revision },
						input: "manage goal",
					})
					.pipe(Effect.provide(Layer.merge(handlers, layer)))
				assert.equal(
					Session.currentTurn(result.session)!.steps,
					plans.length + 1,
				)
				assert.equal(requests, plans.length + 1)
				assert.equal(result.state.value[Goal.pluginId], undefined)
				assert.equal(result.session.business[Goal.pluginId], undefined)
				const fork = yield* store.fork({ source: view.session.id })
				assert.deepEqual(fork.session.business, {})
			}),
		),
	)
})

test("Goal stays Session business state, and Fork and Resume do not schedule work", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { runtime, store, view, handlers } = yield* setup
				const layer = model((prompt) =>
					calls(prompt).length === 0
						? [
								Response.makePart("tool-call", {
									id: "set",
									name: "SetGoal",
									params: {
										objective: "keep this Session goal",
										tokenBudget: 50,
									},
									providerExecuted: false,
								}),
								finish("tool-calls"),
							]
						: [finish("stop")],
				)
				const result = yield* runtime
					.execute({
						base: { session: view.session.id, revision: view.session.revision },
						input: "set goal",
					})
					.pipe(Effect.provide(Layer.merge(handlers, layer)))
				assert.ok(result.session.business[Goal.pluginId] !== undefined)
				assert.equal(result.state.value[Goal.pluginId], undefined)
				const fork = yield* store.fork({ source: view.session.id })
				assert.deepEqual(fork.session.business, {})
				assert.deepEqual(
					(yield* runtime.resume(result.session.id)).session.business,
					result.session.business,
				)
			}),
		),
	)
})

test("a missing goal gives the declared error, and bad parameters never reach storage", async () => {
	for (const params of [
		{ name: "UpdateGoal", value: { objective: "missing" } },
		{ name: "SetGoal", value: { objective: 7 } },
	])
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { runtime, view, handlers } = yield* setup
					let requests = 0
					const layer = model(() => {
						requests++
						return [
							Response.makePart("tool-call", {
								id: "invalid",
								name: params.name,
								params: params.value,
								providerExecuted: false,
							}),
							finish("tool-calls"),
						]
					})
					const failed = yield* Effect.exit(
						runtime
							.execute({
								base: {
									session: view.session.id,
									revision: view.session.revision,
								},
								input: "invalid",
							})
							.pipe(Effect.provide(Layer.merge(handlers, layer))),
					)
					assert.ok(Exit.isFailure(failed))
					assert.equal(requests, 1)
				}),
			),
		)
})
