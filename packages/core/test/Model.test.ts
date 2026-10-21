import { Session } from "@openbot-build/core"
import { Match } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import {
	Effect,
	Layer,
	ManagedRuntime,
	Schema,
	Stream,
	Predicate,
} from "effect"
import {
	LanguageModel,
	Model as AiModel,
	Prompt,
	Response,
	Toolkit,
} from "effect/ai"
import {
	TimelineState,
	SessionStoreMemory,
	SessionRuntime,
	ContextWindow,
	Item,
	Store,
	Config,
	ConfigurationOperations,
	Model,
	Provider,
} from "@openbot-build/core"
import * as ConfigModule from "@openbot-build/core/Config"
import { SessionTest } from "./SessionTest.ts"
import { LanguageModelTest } from "./LanguageModelTest.ts"

const providerId = Provider.Id.make("test-provider")
const modelId = Model.Id.make("test-model")
const selection = Config.Selection.make({
	provider: providerId,
	model: modelId,
	reasoningEffort: "high",
	serviceTier: "priority",
})
const usage = Response.Usage.make({
	inputTokens: {
		total: 1,
		uncached: 1,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 1, text: 1, reasoning: undefined },
})
const finish = Response.makePart("finish", { reason: "stop", usage })

test("configuration catalogs and selections round-trip without runtime capabilities", () => {
	assert.equal(ConfigModule.Selection, Config.Selection)
	assert.equal(ConfigModule.Compaction, Config.Compaction)
	const schema = Schema.Struct({
		providers: Schema.Array(Config.Provider),
		models: Schema.Array(Config.Model),
		selection: Config.Selection,
		mode: Config.Mode,
	})
	const settings = schema.make({
		providers: [
			{
				id: providerId,
				name: "Test Provider",
				endpoint: "https://example.com/models",
			},
			{
				id: Provider.Id.make("local"),
				name: "Local Provider",
				endpoint: "http://localhost:8080",
			},
			{
				id: Provider.Id.make("default"),
				name: "Default Provider",
			},
		],
		models: [
			undefined,
			Config.Compaction.Native(),
			Config.Compaction.NonNative({ model: selection, keepRecentMessages: 3 }),
		].map((compaction) =>
			Config.Model.make({
				provider: providerId,
				id: modelId,
				name: "Test Model",
				reasoningEfforts: ["high"],
				serviceTiers: ["priority"],
				...(compaction === undefined ? {} : { compaction }),
			}),
		),
		selection,
		mode: "plan",
	})
	const codec = Schema.toCodecJson(schema)
	const json = JSON.stringify(Schema.encodeSync(codec)(settings))
	const decoded = Schema.decodeSync(codec)(JSON.parse(json))
	assert.deepEqual(decoded, settings)
	assert.equal(decoded.selection._tag, "Config.Selection")
	const [model] = decoded.models
	assert.ok(model)
	assert.equal(model._tag, "Config.Model")
	assert.equal(Predicate.hasProperty(model, "generateText"), false)
	assert.deepEqual(
		decoded.models.map((model) =>
			model.compaction === undefined
				? "undeclared"
				: Match.value(model.compaction).pipe(
						Match.tagsExhaustive({
							Native: () => "native",
							NonNative: () => "non-native",
						}),
					),
		),
		["undeclared", "native", "non-native"],
	)
	assert.equal(
		Config.Compaction.$is("Native")(decoded.models[1]?.compaction),
		true,
	)
	for (const invalid of [
		true,
		false,
		{ _tag: "Unknown" },
		{ _tag: "NonNative", keepRecentMessages: 0 },
		{ _tag: "NonNative", keepRecentMessages: 1.5 },
	]) {
		assert.throws(() =>
			Schema.decodeUnknownSync(Config.Model)({ ...model, compaction: invalid }),
		)
	}
})

test("a runtime model gives native generation and model identity only when first used", async () => {
	let builds = 0
	let requests = 0
	const layer = Layer.effect(
		LanguageModel.LanguageModel,
		Effect.gen(function* () {
			builds += 1
			return yield* LanguageModel.make({
				generateText: () =>
					Effect.sync(() => {
						requests += 1
						return [
							Response.makePart("text", { text: "native answer" }),
							finish,
						]
					}),
				streamText: () => Stream.empty,
			})
		}),
	)
	const model = Model.make({ provider: providerId, model: modelId, layer })
	const program = Effect.gen(function* () {
		const provider = yield* AiModel.ProviderName
		const name = yield* AiModel.ModelName
		const response = yield* LanguageModel.generateText({ prompt: "hello" })
		return { provider, name, text: response.text }
	})
	await using runtime = ManagedRuntime.make(model)
	assert.equal(builds, 0)
	assert.equal(requests, 0)
	assert.deepEqual(await runtime.runPromise(program), {
		provider: providerId,
		name: modelId,
		text: "native answer",
	})
	assert.equal(builds, 1)
	assert.equal(requests, 1)
})

test("a provider uses selection options and returns a model that a Session can use", async () => {
	let constructions = 0
	const provider = new Provider.Provider({
		id: providerId,
		model: (selected) =>
			Effect.sync(() => {
				constructions += 1
				const answer = `${selected.model}:${selected.reasoningEffort}:${selected.serviceTier}`
				return Model.make({
					provider: providerId,
					model: selected.model,
					layer: Layer.effect(
						LanguageModel.LanguageModel,
						LanguageModel.make({
							generateText: () => Effect.succeed([]),
							streamText: () =>
								Stream.make(
									Response.makePart("text-start", { id: "answer" }),
									Response.makePart("text-delta", {
										id: "answer",
										delta: answer,
									}),
									Response.makePart("text-end", { id: "answer" }),
									finish,
								),
						}),
					),
				})
			}),
	})
	const program = Effect.scoped(
		Effect.gen(function* () {
			const { runtime, runtimeStore, view } = yield* SessionTest({
				toolkit: Toolkit.empty,
				providers: [provider],
				modelCatalog: Effect.succeed([
					Config.Model.make({
						provider: providerId,
						id: modelId,
						name: "Model",
						reasoningEfforts: ["high"],
						serviceTiers: ["priority"],
					}),
				]),
			})
			const configuration = ConfigurationOperations.modelConfiguration({
				store: runtimeStore,
				models: [
					Config.Model.make({
						provider: provider.id,
						id: selection.model,
						name: "Model",
						reasoningEfforts: ["high"],
						serviceTiers: ["priority"],
					}),
				],
				session: view.session.id,
				providers: [
					{
						id: providerId,
						name: "Provider",
						endpoint: undefined,
					},
				],
			})
			yield* configuration.select(selection)
			const selected = yield* runtimeStore.read(view.session.id)
			return yield* runtime.execute({
				base: { session: view.session.id, revision: selected.session.revision },
				input: "answer",
			})
		}),
	)
	await using runtime = ManagedRuntime.make(
		LanguageModelTest({
			streamText: () => Stream.die("Host fallback must not run"),
		}),
	)
	assert.equal(constructions, 0)
	const result = await runtime.runPromise(program)
	assert.equal(constructions, 1)
	const status = Session.status(result.session)
	assert.ok(status._tag === "Completed")
	assert.equal(status.result.text, "test-model:high:priority")
	assert.equal(Session.currentTurn(result.session)!.steps, 1)
})

test("provider model creation keeps host failures unchanged", async () => {
	const failure = new Config.ModelConfigurationError({
		reason: "unsupported-option",
		message: "unsupported reasoning effort",
	})
	const provider = new Provider.Provider({
		id: providerId,
		model: () => Effect.fail(failure),
	})
	assert.equal(
		await Effect.runPromise(provider.model(selection).pipe(Effect.flip)),
		failure,
	)
})

test("model and mode updates keep the Timeline and each change Session settings with one revision", async () => {
	let expectedPrompt = Prompt.empty
	let requests = 0
	await using host = ManagedRuntime.make(
		LanguageModelTest({
			streamText: ({ prompt }) => {
				requests++
				assert.deepEqual(prompt, expectedPrompt)
				return Stream.make(finish)
			},
		}),
	)
	await host.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const definition = yield* Store.define({
					stores: { marker: { scope: "timeline", schema: Schema.String } },
					schemaVersion: "timeline/1",
				})
				const store = yield* SessionStoreMemory.make(definition)
				const initial = TimelineState.initial({ marker: "keep plugin data" })
				const value = {
					...initial,
					conversation: {
						...initial.conversation,
						history: [
							{
								id: Item.Id.make("first"),
								content: Prompt.make("first input"),
							},
							{
								id: Item.Id.make("second"),
								content: Prompt.make("second input"),
							},
						],
						context: ContextWindow.Window.make({
							_tag: "Native",
							provider: providerId,
							model: modelId,
							items: [{ compacted: "opaque context" }],
							prompt: Prompt.make("recent input"),
						}),
					},
				}
				const created = yield* store.create({
					metadata: {},
					value,
					settings: { model: selection },
				})
				const otherModel = Model.Id.make("other-model")
				const otherProvider = Provider.Id.make("other-provider")
				const configuration = ConfigurationOperations.modelConfiguration({
					store,
					session: created.session.id,
					providers: [providerId, otherProvider].map((id) => ({
						id,
						name: id,
					})),
					models: [
						{ provider: providerId, id: modelId },
						{ provider: providerId, id: otherModel },
						{ provider: otherProvider, id: otherModel },
					].map(({ provider, id }) =>
						Config.Model.make({
							provider,
							id,
							name: id,
							reasoningEfforts: ["high", "low"],
							serviceTiers: ["priority"],
						}),
					),
				})
				const options = Config.Selection.make({
					...selection,
					reasoningEffort: "low",
				})
				assert.deepEqual(yield* configuration.select(options), options)
				const selected = yield* store.read(created.session.id)
				assert.equal(selected.session.revision, created.session.revision + 1)
				assert.equal(selected.session.head, created.session.head)
				assert.deepEqual(selected.state, created.state)
				assert.deepEqual(selected.session.settings, {
					...created.session.settings,
					model: options,
				})

				const mode = ConfigurationOperations.executionMode({
					store,
					session: created.session.id,
				})
				assert.equal(yield* mode.set("plan"), "plan")
				assert.equal(yield* mode.get, "plan")
				const planned = yield* store.read(created.session.id)
				assert.equal(planned.session.revision, selected.session.revision + 1)
				assert.equal(planned.session.head, selected.session.head)
				assert.deepEqual(planned.state, selected.state)
				assert.deepEqual(planned.session.settings, {
					...selected.session.settings,
					mode: "plan",
				})

				const switched = Config.Selection.make({
					...options,
					model: otherModel,
				})
				yield* configuration.select(switched)
				const changed = yield* store.read(created.session.id)
				assert.equal(changed.session.revision, planned.session.revision + 1)
				assert.equal(changed.session.head, planned.session.head)
				assert.deepEqual(changed.state, planned.state)
				assert.deepEqual(changed.session.settings, {
					...planned.session.settings,
					model: switched,
				})
				assert.equal(
					(yield* store.export(created.session.id)).versions.length,
					1,
				)
				const runtime = yield* SessionRuntime.make({ store, agent: {} })
				expectedPrompt = Prompt.concat(
					TimelineState.fullHistory(value),
					Prompt.make("model switch input"),
				)
				const modelTurn = yield* runtime.execute({
					base: {
						session: changed.session.id,
						revision: changed.session.revision,
					},
					input: "model switch input",
				})
				assert.equal(modelTurn.state.value.conversation.context._tag, "Prompt")
				assert.deepEqual(
					Session.currentTurn(modelTurn.session)!.settings.model,
					switched,
				)
				const native = yield* store.commit({
					expected: modelTurn.session,
					value,
				})
				assert.deepEqual(native.state.version.parents, [modelTurn.session.head])

				const providerSwitch = Config.Selection.make({
					...switched,
					provider: otherProvider,
				})
				yield* configuration.select(providerSwitch)
				const changedProvider = yield* store.read(created.session.id)
				assert.equal(
					changedProvider.session.revision,
					native.session.revision + 1,
				)
				assert.equal(changedProvider.session.head, native.session.head)
				assert.deepEqual(changedProvider.state, native.state)
				assert.deepEqual(changedProvider.session.settings, {
					...native.session.settings,
					model: providerSwitch,
				})
				assert.deepEqual(yield* configuration.get, providerSwitch)
				expectedPrompt = Prompt.concat(
					TimelineState.fullHistory(value),
					Prompt.make("provider switch input"),
				)
				const providerTurn = yield* runtime.execute({
					base: {
						session: changedProvider.session.id,
						revision: changedProvider.session.revision,
					},
					input: "provider switch input",
				})
				assert.equal(
					providerTurn.state.value.conversation.context._tag,
					"Prompt",
				)
				assert.deepEqual(
					Session.currentTurn(providerTurn.session)!.settings.model,
					providerSwitch,
				)
				const historical = yield* store.readVersion(created.session.head)
				assert.deepEqual(historical.value, value)
			}),
		),
	)
	assert.equal(requests, 2)
})
