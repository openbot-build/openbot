import assert from "node:assert/strict"
import { test } from "node:test"
import {
	Effect,
	Layer,
	ManagedRuntime,
	Match,
	Option,
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
	Chat,
	ChatState,
	ChatStoreMemory,
	ChatRuntime,
	ContextWindow,
	Item,
	Store,
	Config,
	ConfigurationOperations,
	Model,
	Provider,
} from "@openbot-build/core"
import * as ConfigModule from "@openbot-build/core/Config"
import { ChatTest } from "./ChatTest.ts"
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

test("a provider uses selection options and returns a model that a Chat can use", async () => {
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
			const { runtime, runtimeStore, chat } = yield* ChatTest({
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
				chat,
				providers: [
					{
						id: providerId,
						name: "Provider",
						endpoint: undefined,
					},
				],
			})
			yield* configuration.select(selection)
			return yield* runtime.execute({ chat, input: "answer" })
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
	const status = Chat.status(result.chat)
	assert.ok(status._tag === "Completed")
	assert.equal(status.result.text, "test-model:high:priority")
	assert.equal(Chat.currentTurn(result.chat)!.steps, 1)
	assert.deepEqual(Chat.currentTurn(result.chat)!.settings.model, selection)
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

test("model and mode updates keep the state, and each changes the Chat settings with one revision", async () => {
	let prompts: ReadonlyArray<Prompt.Prompt> = []
	await using host = ManagedRuntime.make(
		LanguageModelTest({
			streamText: ({ prompt }) => {
				prompts = [...prompts, prompt]
				return Stream.make(finish)
			},
		}),
	)
	/** The native window belongs to another model. The new model gets its messages after a note. */
	const assertRebuilt = (prompt: Prompt.Prompt | undefined, input: string) => {
		assert.ok(prompt)
		const [note, ...rest] = prompt.content
		assert.ok(note !== undefined && note.role === "user")
		assert.match(JSON.stringify(note), /compacted for another model/)
		assert.deepEqual(
			rest,
			Prompt.concat(Prompt.make("recent input"), Prompt.make(input)).content,
		)
	}
	await host.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const definition = yield* Store.define({
					stores: { marker: { scope: "state", schema: Schema.String } },
					schemaVersion: "chat/1",
				})
				const store = yield* ChatStoreMemory.make(definition)
				const initial = ChatState.initial({ marker: "keep plugin data" })
				const value = {
					...initial,
					conversation: {
						...initial.conversation,
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
					value,
					settings: { model: selection },
				})
				const chat = created.chat.id
				yield* store.modifyEffect({
					chat,
					update: () =>
						Effect.succeed([
							undefined,
							Option.some({
								append: [
									{
										id: Item.Id.make("first"),
										content: Prompt.make("first input"),
									},
								],
							}),
						] as const),
				})
				const start = yield* store.read(chat)
				const otherModel = Model.Id.make("other-model")
				const otherProvider = Provider.Id.make("other-provider")
				const configuration = ConfigurationOperations.modelConfiguration({
					store,
					chat,
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
				const selected = yield* store.read(chat)
				assert.equal(selected.chat.revision, start.chat.revision + 1)
				assert.equal(selected.chat.seq, start.chat.seq)
				assert.deepEqual(selected.state, start.state)
				assert.deepEqual(selected.chat.settings, {
					...start.chat.settings,
					model: options,
				})

				const mode = ConfigurationOperations.executionMode({ store, chat })
				assert.equal(yield* mode.set("plan"), "plan")
				assert.equal(yield* mode.get, "plan")
				const planned = yield* store.read(chat)
				assert.equal(planned.chat.revision, selected.chat.revision + 1)
				assert.deepEqual(planned.state, selected.state)
				assert.deepEqual(planned.chat.settings, {
					...selected.chat.settings,
					mode: "plan",
				})

				const switched = Config.Selection.make({
					...options,
					model: otherModel,
				})
				yield* configuration.select(switched)
				const changed = yield* store.read(chat)
				assert.equal(changed.chat.revision, planned.chat.revision + 1)
				assert.deepEqual(changed.state, planned.state)
				assert.deepEqual(changed.chat.settings, {
					...planned.chat.settings,
					model: switched,
				})
				assert.equal(changed.chat.seq, start.chat.seq)
				const runtime = yield* ChatRuntime.make({ store, bot: {} })
				const modelTurn = yield* runtime.execute({
					chat,
					input: "model switch input",
				})
				assertRebuilt(prompts.at(-1), "model switch input")
				assert.doesNotMatch(JSON.stringify(prompts.at(-1)), /first input/)
				assert.equal(modelTurn.state.conversation.context._tag, "Prompt")
				assert.deepEqual(
					Chat.currentTurn(modelTurn.chat)!.settings.model,
					switched,
				)
				assert.equal(modelTurn.state["marker"], "keep plugin data")
				const native = (yield* store.modifyEffect({
					chat,
					update: (current) =>
						Effect.succeed([
							undefined,
							Option.some({ value: { ...current.state, ...value } }),
						] as const),
				})).view
				assert.equal(native.chat.revision, modelTurn.chat.revision + 1)

				const providerSwitch = Config.Selection.make({
					...switched,
					provider: otherProvider,
				})
				yield* configuration.select(providerSwitch)
				const changedProvider = yield* store.read(chat)
				assert.equal(changedProvider.chat.revision, native.chat.revision + 1)
				assert.deepEqual(changedProvider.state, native.state)
				assert.deepEqual(changedProvider.chat.settings, {
					...native.chat.settings,
					model: providerSwitch,
				})
				assert.deepEqual(yield* configuration.get, providerSwitch)
				const providerTurn = yield* runtime.execute({
					chat,
					input: "provider switch input",
				})
				assertRebuilt(prompts.at(-1), "provider switch input")
				assert.equal(providerTurn.state.conversation.context._tag, "Prompt")
				assert.deepEqual(
					Chat.currentTurn(providerTurn.chat)!.settings.model,
					providerSwitch,
				)
			}),
		),
	)
	assert.equal(prompts.length, 2)
})
