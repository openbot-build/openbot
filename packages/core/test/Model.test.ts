import { assert, it } from "@effect/vitest"
import {
	Array as Arr,
	Effect,
	Layer,
	Match,
	Option,
	Schema,
	Stream,
	Predicate,
	Ref,
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
import { finish, LanguageModelTest, textParts } from "./LanguageModelTest.ts"

const providerId = Provider.Id.make("test-provider")
const modelId = Model.Id.make("test-model")
const selection = Config.Selection.make({
	provider: providerId,
	model: modelId,
	reasoningEffort: "high",
	serviceTier: "priority",
})
/** The JSON text of a value, so a test can match a pattern in it. */
const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

it.effect(
	"configuration catalogs and selections round-trip without runtime capabilities",
	() =>
		Effect.gen(function* () {
			assert.strictEqual(ConfigModule.Selection, Config.Selection)
			assert.strictEqual(ConfigModule.Compaction, Config.Compaction)
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
				models: Arr.map(
					[
						undefined,
						Config.Compaction.Native(),
						Config.Compaction.NonNative({
							model: selection,
							keepRecentMessages: 3,
						}),
					],
					(compaction) =>
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
			const codec = Schema.fromJsonString(Schema.toCodecJson(schema))
			const text = yield* Schema.encodeEffect(codec)(settings)
			const decoded = yield* Schema.decodeEffect(codec)(text)
			assert.deepStrictEqual(decoded, settings)
			assert.strictEqual(decoded.selection._tag, "Config.Selection")
			const [model] = decoded.models
			assert.ok(model)
			assert.strictEqual(model._tag, "Config.Model")
			assert.strictEqual(Predicate.hasProperty(model, "generateText"), false)
			assert.deepStrictEqual(
				Arr.map(decoded.models, (model) =>
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
			assert.strictEqual(
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
				const error = yield* Schema.decodeUnknownEffect(Config.Model)({
					...model,
					compaction: invalid,
				}).pipe(Effect.flip)
				assert.strictEqual(error._tag, "SchemaError")
			}
		}),
)

it.effect(
	"a runtime model gives native generation and model identity only when first used",
	() =>
		Effect.gen(function* () {
			const builds = yield* Ref.make(0)
			const requests = yield* Ref.make(0)
			const layer = Layer.effect(
				LanguageModel.LanguageModel,
				Effect.gen(function* () {
					yield* Ref.update(builds, (n) => n + 1)
					return yield* LanguageModel.make({
						generateText: () =>
							Ref.update(requests, (n) => n + 1).pipe(
								Effect.as([
									Response.makePart("text", { text: "native answer" }),
									finish(),
								]),
							),
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
			assert.strictEqual(yield* Ref.get(builds), 0)
			assert.strictEqual(yield* Ref.get(requests), 0)
			assert.deepStrictEqual(yield* program.pipe(Effect.provide(model)), {
				provider: providerId,
				name: modelId,
				text: "native answer",
			})
			assert.strictEqual(yield* Ref.get(builds), 1)
			assert.strictEqual(yield* Ref.get(requests), 1)
		}),
)

it.effect(
	"a provider uses selection options and returns a model that a Chat can use",
	() =>
		Effect.gen(function* () {
			const constructions = yield* Ref.make(0)
			const provider = new Provider.Provider({
				id: providerId,
				model: (selected) =>
					Effect.gen(function* () {
						yield* Ref.update(constructions, (n) => n + 1)
						const answer = `${selected.model}:${selected.reasoningEffort}:${selected.serviceTier}`
						return Model.make({
							provider: providerId,
							model: selected.model,
							layer: Layer.effect(
								LanguageModel.LanguageModel,
								LanguageModel.make({
									generateText: () => Effect.succeed([]),
									streamText: () => Stream.fromArray(textParts(answer)),
								}),
							),
						})
					}),
			})
			assert.strictEqual(yield* Ref.get(constructions), 0)
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
			const result = yield* runtime.execute({ chat, input: "answer" })
			assert.strictEqual(yield* Ref.get(constructions), 1)
			const status = Chat.status(result.chat)
			assert.ok(status._tag === "Completed")
			assert.strictEqual(status.result.text, "test-model:high:priority")
			assert.strictEqual(Chat.currentTurn(result.chat)!.steps, 1)
			assert.deepStrictEqual(
				Chat.currentTurn(result.chat)!.settings.model,
				selection,
			)
		}).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () => Stream.die("Host fallback must not run"),
				}),
			),
		),
)

it.effect("provider model creation keeps host failures unchanged", () =>
	Effect.gen(function* () {
		const failure = Config.ModelConfigurationError.make({
			reason: "unsupported-option",
			message: "unsupported reasoning effort",
		})
		const provider = new Provider.Provider({
			id: providerId,
			model: () => Effect.fail(failure),
		})
		assert.strictEqual(yield* Effect.flip(provider.model(selection)), failure)
	}),
)

it.effect(
	"model and mode updates keep the state, and each changes the Chat settings with one revision",
	() => {
		let prompts: ReadonlyArray<Prompt.Prompt> = []
		const languageModel = LanguageModelTest({
			streamText: ({ prompt }) => {
				prompts = [...prompts, prompt]
				return Stream.make(finish())
			},
		})
		/** Another model reads the full portable history, not an opaque native window. */
		const assertRebuilt = (
			prompt: Prompt.Prompt | undefined,
			history: Prompt.Prompt,
			input: string,
		) =>
			Effect.gen(function* () {
				assert.ok(prompt)
				assert.deepStrictEqual(
					prompt.content,
					Prompt.concat(history, Prompt.make(input)).content,
				)
				assert.notMatch(yield* json(prompt), /compacted for another model/)
			})
		return Effect.gen(function* () {
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
								{
									id: Item.Id.make("recent"),
									content: Prompt.make("recent input"),
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
				providers: Arr.map([providerId, otherProvider], (id) => ({
					id,
					name: id,
				})),
				models: Arr.map(
					[
						{ provider: providerId, id: modelId },
						{ provider: providerId, id: otherModel },
						{ provider: otherProvider, id: otherModel },
					],
					({ provider, id }) =>
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
			assert.deepStrictEqual(yield* configuration.select(options), options)
			const selected = yield* store.read(chat)
			assert.strictEqual(selected.chat.revision, start.chat.revision + 1)
			assert.strictEqual(selected.chat.seq, start.chat.seq)
			assert.deepStrictEqual(selected.state, start.state)
			assert.deepStrictEqual(selected.chat.settings, {
				...start.chat.settings,
				model: options,
			})

			const mode = ConfigurationOperations.executionMode({ store, chat })
			assert.strictEqual(yield* mode.set("plan"), "plan")
			assert.strictEqual(yield* mode.get, "plan")
			const planned = yield* store.read(chat)
			assert.strictEqual(planned.chat.revision, selected.chat.revision + 1)
			assert.deepStrictEqual(planned.state, selected.state)
			assert.deepStrictEqual(planned.chat.settings, {
				...selected.chat.settings,
				mode: "plan",
			})

			const switched = Config.Selection.make({
				...options,
				model: otherModel,
			})
			yield* configuration.select(switched)
			const changed = yield* store.read(chat)
			assert.strictEqual(changed.chat.revision, planned.chat.revision + 1)
			assert.deepStrictEqual(changed.state, planned.state)
			assert.deepStrictEqual(changed.chat.settings, {
				...planned.chat.settings,
				model: switched,
			})
			assert.strictEqual(changed.chat.seq, start.chat.seq)
			const runtime = yield* ChatRuntime.make({ store, bot: {} })
			const beforeModel = ChatState.promptOf(yield* store.items(chat))
			const modelTurn = yield* runtime.execute({
				chat,
				input: "model switch input",
			})
			yield* assertRebuilt(prompts.at(-1), beforeModel, "model switch input")
			assert.match(yield* json(prompts.at(-1)), /first input/)
			assert.strictEqual(modelTurn.state.conversation.context._tag, "Prompt")
			assert.deepStrictEqual(
				Chat.currentTurn(modelTurn.chat)!.settings.model,
				switched,
			)
			assert.strictEqual(modelTurn.state["marker"], "keep plugin data")
			const native = (yield* store.modifyEffect({
				chat,
				update: (current) =>
					Effect.succeed([
						undefined,
						Option.some({ value: { ...current.state, ...value } }),
					] as const),
			})).view
			assert.strictEqual(native.chat.revision, modelTurn.chat.revision + 1)

			const providerSwitch = Config.Selection.make({
				...switched,
				provider: otherProvider,
			})
			yield* configuration.select(providerSwitch)
			const changedProvider = yield* store.read(chat)
			assert.strictEqual(
				changedProvider.chat.revision,
				native.chat.revision + 1,
			)
			assert.deepStrictEqual(changedProvider.state, native.state)
			assert.deepStrictEqual(changedProvider.chat.settings, {
				...native.chat.settings,
				model: providerSwitch,
			})
			assert.deepStrictEqual(yield* configuration.get, providerSwitch)
			const beforeProvider = ChatState.promptOf(yield* store.items(chat))
			const providerTurn = yield* runtime.execute({
				chat,
				input: "provider switch input",
			})
			yield* assertRebuilt(
				prompts.at(-1),
				beforeProvider,
				"provider switch input",
			)
			assert.strictEqual(providerTurn.state.conversation.context._tag, "Prompt")
			assert.deepStrictEqual(
				Chat.currentTurn(providerTurn.chat)!.settings.model,
				providerSwitch,
			)
			assert.strictEqual(prompts.length, 2)
		}).pipe(Effect.provide(languageModel))
	},
)
