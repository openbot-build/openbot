import { Item, Config, Model, Provider } from "@openbot-build/core"
import { AppExecution } from "@openbot-build/api"
import * as Memory from "../plugins/memory/Memory.ts"
import {
	Context,
	Effect,
	Layer,
	Match,
	Record as EffectRecord,
	Schema,
	Stream,
} from "effect"
import {
	AiError,
	LanguageModel,
	Prompt,
	Response,
	Tool,
	Toolkit,
} from "effect/ai"
import * as Assistance from "../plugins/apps/Assistance.ts"

/** Each development scenario and what it does. The scenario ids come from these keys. */
const descriptions = {
	"mock-text": "Fixed text with simulated usage and no added delay.",
	"mock-slow":
		"Text sent over ten seconds that you can interrupt, with simulated usage.",
	"mock-tool": "A safe development tool that waits for real approval.",
	"mock-app":
		"Uses the simulated App's real MCP handler and its returned content.",
	"mock-failure":
		"A typed model failure on purpose, after some streamed output.",
} as const satisfies Readonly<Record<string, string>>

export const Scenario = Schema.Literals(EffectRecord.keys(descriptions))
export type Scenario = typeof Scenario.Type

export const provider = Provider.Id.make("development")
export const selection = Config.Selection.make({
	provider,
	model: Model.Id.make("mock-text" satisfies Scenario),
})

/** The first model is the default of a new Session. */
export const catalog = Effect.succeed({
	providers: [{ id: provider, name: "Development scenarios (simulated)" }],
	models: [
		selection.model,
		...Scenario.literals.filter((scenario) => scenario !== selection.model),
	].map((scenario) =>
		Config.Model.make({
			provider,
			id: Model.Id.make(scenario),
			name: `${scenario} (simulated)`,
			description: descriptions[scenario as Scenario],
			reasoningEfforts: [],
			serviceTiers: [],
		}),
	),
})

const Confirmation = Schema.Struct({ confirmed: Schema.NonEmptyString })
export const confirmation = Tool.make("DevelopmentConfirmation", {
	description:
		"Confirm a development scenario without changing files or external services.",
	parameters: Schema.Struct({ description: Schema.NonEmptyString }),
	success: Confirmation,
	needsApproval: true,
})
export const toolkit = Toolkit.make(confirmation)
export const layerTools = toolkit.toLayer({
	DevelopmentConfirmation: ({ description }) =>
		Effect.succeed({ confirmed: description }),
})

const ExtractionRequest = Schema.Struct({
	state: Memory.State,
	history: Schema.Array(Item.Record),
})
const invalidRequest = (description: string) =>
	AiError.make({
		module: "DevelopmentModel",
		method: "generateText",
		reason: AiError.InvalidRequestError.make({ description }),
	})
const failedScenario = () =>
	AiError.make({
		module: "DevelopmentModel",
		method: "generateText",
		reason: AiError.InvalidOutputError.make({
			description: "The mock-failure development scenario failed on purpose",
		}),
	})

const currentInput = Effect.fn("DevelopmentModel.currentInput")(function* (
	prompt: Prompt.Prompt,
) {
	const index = prompt.content.findLastIndex(
		(message) => message.role === "user",
	)
	const text = yield* Match.value(prompt.content[index]).pipe(
		Match.when({ role: "user" }, (message) =>
			message.content.some((part) => part.type !== "text")
				? Effect.fail(
						invalidRequest("Development scenarios require text input"),
					)
				: Effect.succeed(
						message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join(""),
					),
		),
		Match.orElse(() =>
			Effect.fail(
				invalidRequest("Development scenarios require a user message"),
			),
		),
	)
	return { text, index }
})

const usage = {
	inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}
const finish = (scenario: Scenario, reason: Response.FinishReason = "stop") =>
	Response.makePart("finish", {
		reason,
		usage,
		metadata: { development: { scenario, syntheticUsage: true } },
	})
type GeneratedPart = Extract<
	Response.PartEncoded,
	{ readonly type: "text" | "tool-call" | "finish" }
>

const textParts = (scenario: Scenario, text: string): Array<GeneratedPart> => [
	Response.makePart("text", { text }),
	finish(scenario),
]

const structured = Effect.fn("DevelopmentModel.structured")(function* (
	objectName: string,
	prompt: Prompt.Prompt,
) {
	const { text } = yield* currentInput(prompt)
	return yield* Match.value(objectName).pipe(
		Match.when("memory_changes", () =>
			Schema.decodeEffect(Schema.fromJsonString(ExtractionRequest))(text).pipe(
				Effect.andThen(Schema.decodeEffect(Memory.Extraction)({ changes: [] })),
			),
		),
		Match.orElse(() =>
			Effect.fail(
				invalidRequest(
					`Unsupported structured development request: ${objectName}`,
				),
			),
		),
		Effect.catchTag("SchemaError", () =>
			Effect.fail(invalidRequest(`Invalid input or result for ${objectName}`)),
		),
		Effect.map((value) => JSON.stringify(value)),
	)
})

const toolParts = Effect.fn("DevelopmentModel.toolParts")(function* (
	options: LanguageModel.ProviderOptions,
) {
	const { text, index } = yield* currentInput(options.prompt)
	const id = `development-confirmation-${index}`
	const result = options.prompt.content
		.slice(index + 1)
		.flatMap((message) =>
			Match.value(message).pipe(
				Match.when({ role: "tool" }, (message) =>
					message.content.filter(
						(part) =>
							part.type === "tool-result" &&
							part.name === confirmation.name &&
							part.id === id,
					),
				),
				Match.orElse(() => []),
			),
		)
		.findLast((part) => part.type === "tool-result")
	if (result !== undefined) {
		if (result.isFailure)
			return textParts(
				"mock-tool",
				`Development confirmation was rejected: ${JSON.stringify(result.result)}`,
			)
		const value = yield* Schema.decodeUnknownEffect(Confirmation)(
			result.result,
		).pipe(
			Effect.mapError(() =>
				invalidRequest("The development tool returned an invalid confirmation"),
			),
		)
		return textParts(
			"mock-tool",
			`Development confirmation result: ${value.confirmed}`,
		)
	}
	if (!options.tools.some((tool) => tool.name === confirmation.name))
		return yield* invalidRequest(
			"The DevelopmentConfirmation tool is unavailable",
		)
	return [
		Response.makePart("tool-call", {
			id,
			name: confirmation.name,
			params: {
				description: text.trim() || "Confirm the development scenario",
			},
			providerExecuted: false,
		}),
		finish("mock-tool", "tool-calls"),
	]
})

const appParts = Effect.fn("DevelopmentModel.appParts")(function* (
	options: LanguageModel.ProviderOptions,
) {
	const { index, text } = yield* currentInput(options.prompt)
	const result = options.prompt.content
		.slice(index + 1)
		.flatMap((message) =>
			Match.value(message).pipe(
				Match.when({ role: "tool" }, (message) =>
					message.content.filter(
						(part) =>
							part.type === "tool-result" && part.name.startsWith("openbot_"),
					),
				),
				Match.orElse(() => []),
			),
		)
		.findLast((part) => part.type === "tool-result")
	if (result !== undefined) {
		const value = yield* Schema.decodeUnknownEffect(AppExecution.ToolResult)(
			result.result,
		).pipe(
			Effect.mapError(() =>
				invalidRequest("The simulated App result does not match its contract"),
			),
		)
		return textParts(
			"mock-app",
			Match.value(value).pipe(
				Match.tag(
					"Completed",
					({ result, source }) =>
						`Simulated App result from ${source.connectionName}: ${JSON.stringify(result)}`,
				),
				Match.tag("Failed", ({ message }) => message),
				Match.tag("InputRequired", () => "The simulated App needs more input."),
				Match.tag("AppCandidates", ({ page }) =>
					page.apps.length === 0
						? "No matching App was found. Add a known App by address or try another public capability search."
						: "Review the real App candidates below and add the account you want. Then return here and explicitly continue the original task.",
				),
				Match.tag(
					"AppDetails",
					({ app }) =>
						"Review this App before adding: " +
						(app.entry.card.title ?? app.entry.card.name),
				),
				Match.tag(
					"AppAccess",
					() =>
						"Choose which App account should do this task, or finish its configuration and authorization in My Apps. Then explicitly continue this Session.",
				),
				Match.tag("AppAssistanceFailed", ({ message }) => message),
				Match.exhaustive,
			),
		)
	}
	const choices = options.tools.filter(
		(tool) => tool.description?.includes(" / read_document.") === true,
	)
	const selected = choices.filter((tool) => {
		const account = tool.description?.split(" / ")[1]
		return (
			account !== undefined &&
			text
				.toLocaleLowerCase("en-US")
				.includes(account.toLocaleLowerCase("en-US"))
		)
	})
	const tool =
		selected.length === 1
			? selected[0]
			: choices.length === 1
				? choices[0]
				: undefined
	if (tool === undefined) {
		const assistance = options.tools.find(
			(candidate) =>
				candidate.name ===
				(choices.length === 0
					? Assistance.names.search
					: Assistance.names.access),
		)
		if (assistance === undefined)
			return textParts(
				"mock-app",
				"App discovery is unavailable in this host. Add an App by address and explicitly continue this Session.",
			)
		return [
			Response.makePart("tool-call", {
				id: "development-app-assistance-" + index,
				name: assistance.name,
				params: choices.length === 0 ? { query: "document" } : {},
				providerExecuted: false,
			}),
			finish("mock-app", "tool-calls"),
		]
	}
	return [
		Response.makePart("tool-call", {
			id: "development-app-" + index,
			name: tool.name,
			params: { id: "development-document" },
			providerExecuted: false,
		}),
		finish("mock-app", "tool-calls"),
	]
})

const generate = Effect.fn("DevelopmentModel.generate")(function* (
	scenario: Scenario,
	options: LanguageModel.ProviderOptions,
) {
	return yield* Match.value(options.responseFormat).pipe(
		Match.when({ type: "json" }, (format) =>
			structured(format.objectName, options.prompt).pipe(
				Effect.map((text) => textParts(scenario, text)),
			),
		),
		Match.when({ type: "text" }, () =>
			Match.value(scenario).pipe(
				Match.when("mock-failure", () => Effect.fail(failedScenario())),
				Match.when("mock-tool", () => toolParts(options)),
				Match.when("mock-app", () => appParts(options)),
				Match.whenOr("mock-text", "mock-slow", (scenario) =>
					currentInput(options.prompt).pipe(
						Effect.map(({ text }) =>
							textParts(scenario, `Development response: ${text}`),
						),
					),
				),
				Match.exhaustive,
			),
		),
		Match.exhaustive,
	)
})

const streamAnswer = (scenario: Scenario, text: string) => {
	const delta = (text: string) =>
		Response.makePart("text-delta", { id: "answer", delta: text })
	const body = Match.value(scenario).pipe(
		Match.when("mock-slow", () =>
			Stream.succeed(delta(text.slice(0, 12))).pipe(
				Stream.concat(
					Stream.fromEffect(
						Effect.as(Effect.sleep("5 seconds"), delta(text.slice(12, 24))),
					),
				),
				Stream.concat(
					Stream.fromEffect(
						Effect.as(Effect.sleep("5 seconds"), delta(text.slice(24))),
					),
				),
			),
		),
		Match.orElse(() => Stream.succeed(delta(text))),
	)
	return Stream.succeed(Response.makePart("text-start", { id: "answer" })).pipe(
		Stream.concat(body),
		Stream.concat(
			Stream.succeed(Response.makePart("text-end", { id: "answer" })),
		),
	)
}

/** LanguageModel.make still does the native Effect AI decoding, approvals and tool execution. */
export const layer = (scenario: Scenario): Model.Model =>
	Model.make({
		provider,
		model: Model.Id.make(scenario),
		layer: Layer.effect(
			LanguageModel.LanguageModel,
			LanguageModel.make({
				generateText: (options) =>
					generate(scenario, options).pipe(
						Effect.tap(() =>
							Match.value({ scenario, format: options.responseFormat }).pipe(
								Match.when(
									{ scenario: "mock-slow", format: { type: "text" } },
									() => Effect.sleep("10 seconds"),
								),
								Match.orElse(() => Effect.void),
							),
						),
					),
				streamText: (options) =>
					Match.value(scenario).pipe(
						Match.when("mock-failure", () =>
							Stream.make(
								Response.makePart("text-start", { id: "answer" }),
								Response.makePart("text-delta", {
									id: "answer",
									delta: "Development failure: partial output.",
								}),
							).pipe(Stream.concat(Stream.fail(failedScenario()))),
						),
						Match.orElse(() =>
							Stream.unwrap(
								generate(scenario, options).pipe(
									Effect.map((parts) =>
										Stream.fromIterable(parts).pipe(
											Stream.flatMap((part) =>
												Match.value(part).pipe(
													Match.when({ type: "text" }, ({ text }) =>
														streamAnswer(scenario, text),
													),
													Match.orElse((part) => Stream.succeed(part)),
												),
											),
										),
									),
								),
							),
						),
					),
			}),
		),
	})

/** Build one immutable directory for each application. No scenario has a response cursor. */
export const make = Effect.gen(function* () {
	const models = yield* Effect.all(
		EffectRecord.map(descriptions, (_, scenario) =>
			Effect.map(Layer.build(layer(scenario)), (context) =>
				Context.get(context, LanguageModel.LanguageModel),
			),
		),
	)
	const resolve = (requested: Config.Selection | undefined) =>
		Effect.gen(function* () {
			const current = requested ?? selection
			if (current.provider !== provider)
				return yield* new Config.ModelConfigurationError({
					reason: "provider-not-found",
					message: "The development provider is unavailable",
				})
			if (
				current.reasoningEffort !== undefined ||
				current.serviceTier !== undefined
			)
				return yield* new Config.ModelConfigurationError({
					reason: "unsupported-option",
					message:
						"Development scenarios do not support reasoning effort or service tiers",
				})
			const scenario = yield* Schema.decodeUnknownEffect(Scenario)(
				current.model,
			).pipe(
				Effect.mapError(
					() =>
						new Config.ModelConfigurationError({
							reason: "model-not-found",
							message: "The development scenario is unavailable",
						}),
				),
			)
			return models[scenario]
		})
	const { providers, models: list } = yield* catalog
	return {
		/** Every organization of a development platform can use the simulated models. */
		builtinModels: {
			providers,
			models: list,
			resolve: (selection: Config.Selection) => resolve(selection),
		},
		sessions: {
			runtime: { toolkit },
			layerExecution: () => layerTools,
		},
	}
})
