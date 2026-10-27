import { Config, Model, Provider } from "@openbot-build/core"
import { AppExecution } from "@openbot-build/api"
import { AppCalls, Execution } from "@openbot-build/domain"

import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Match,
	Option,
	Predicate,
	Record as Rec,
	Schema,
	Stream,
	String as Str,
	pipe,
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
import * as HostTools from "../chats/HostTools.ts"

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

export const Scenario = Schema.Literals(Rec.keys(descriptions))
export type Scenario = typeof Scenario.Type

export const provider = Provider.Id.make("development")
const defaultScenario: Scenario = "mock-text"
/**
 * The model of a new Chat on a development platform when its Bot names none.
 * A development platform is a simulation, so it gives each new Chat a
 * simulated model. A real platform has no such default.
 */
export const selection = Config.Selection.make({
	provider,
	model: Model.Id.make(defaultScenario),
})

/** The simulated models of a development platform. */
const catalog = {
	providers: [{ id: provider, name: "Development scenarios (simulated)" }],
	models: pipe(
		Scenario.literals,
		Arr.filter((scenario) => scenario !== defaultScenario),
		Arr.prepend(defaultScenario),
		Arr.map((scenario) =>
			Config.Model.make({
				provider,
				id: Model.Id.make(scenario),
				name: `${scenario} (simulated)`,
				description: descriptions[scenario],
				reasoningEfforts: [],
				serviceTiers: [],
			}),
		),
	),
}

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
/** Every Turn of a development platform can call the development tool. */
export const layerHostTools = HostTools.layer({
	toolkit,
	handlers: () => layerTools,
})

const invalidRequest = (description: string) =>
	AiError.make({
		module: "DevelopmentModel",
		method: "generateText",
		reason: AiError.InvalidRequestError.make({ description }),
	})

/** It is a function, so each failure gets a new error with its own stack. */
const scenarioFailure = () =>
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
	const { message, index } = yield* Effect.fromOption(
		Arr.findLast(prompt.content, (message, index) =>
			message.role === "user" ? Option.some({ message, index }) : Option.none(),
		),
		() => invalidRequest("Development scenarios require a user message"),
	)
	if (Arr.some(message.content, (part) => part.type !== "text"))
		return yield* invalidRequest("Development scenarios require text input")
	const text = pipe(
		message.content,
		Arr.filter((part) => part.type === "text"),
		Arr.map((part) => part.text),
		Arr.join(""),
	)
	return { text, index }
})

/** Tool results in a prompt are JSON values, so a failure to encode one is a defect. */
const encodeJson = (value: unknown) =>
	Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(
		Effect.orDie,
	)

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

/** The development models answer no structured requests. They check the input first. */
const structured = Effect.fn("DevelopmentModel.structured")(function* (
	objectName: string,
	prompt: Prompt.Prompt,
) {
	yield* currentInput(prompt)
	return yield* invalidRequest(
		`Unsupported structured development request: ${objectName}`,
	)
})

/**
 * The last result of a tool whose name `name` accepts. It looks only after the
 * user message at `index`, so a result of an earlier step does not count.
 */
const lastToolResult = (
	prompt: Prompt.Prompt,
	index: number,
	name: Predicate.Predicate<string>,
) =>
	pipe(
		prompt.content,
		Arr.drop(index + 1),
		Arr.flatMap((message) => (message.role === "tool" ? message.content : [])),
		Arr.findLast(
			(part): part is Prompt.ToolResultPart =>
				part.type === "tool-result" && name(part.name),
		),
	)

const toolParts = Effect.fn("DevelopmentModel.toolParts")(function* (
	options: LanguageModel.ProviderOptions,
) {
	const { text, index } = yield* currentInput(options.prompt)
	const id = `development-confirmation-${index}`
	// The result of the call of this step, or of a call that a decider allowed later.
	const found = lastToolResult(
		options.prompt,
		index,
		(name) => name === confirmation.name,
	)
	if (Option.isSome(found)) {
		const result = found.value
		// A call that waits for a decision has a pending result. Its answer comes later.
		if (Predicate.hasProperty(result.result, "pending"))
			return textParts(
				"mock-tool",
				"Development confirmation waits for a decision.",
			)
		if (result.isFailure)
			return textParts(
				"mock-tool",
				`Development confirmation was rejected: ${yield* encodeJson(result.result)}`,
			)
		const value = yield* Schema.decodeUnknownEffect(Confirmation)(
			result.result,
		).pipe(
			Effect.mapError((error) =>
				invalidRequest(
					`The development tool returned an invalid confirmation: ${error.message}`,
				),
			),
		)
		return textParts(
			"mock-tool",
			`Development confirmation result: ${value.confirmed}`,
		)
	}
	if (!Arr.some(options.tools, (tool) => tool.name === confirmation.name))
		return yield* invalidRequest(
			"The DevelopmentConfirmation tool is unavailable",
		)
	return [
		Response.makePart("tool-call", {
			id,
			name: confirmation.name,
			params: {
				description: Str.trim(text) || "Confirm the development scenario",
			},
			providerExecuted: false,
		}),
		finish("mock-tool", "tool-calls"),
	]
})

const AppAnswer = Schema.Struct({
	source: AppCalls.Source,
	outcome: Schema.NullOr(AppCalls.Outcome),
	failure: Schema.NullOr(Execution.Failure),
})
const ToolNotice = Schema.Struct({
	status: Execution.Status,
	failure: Schema.NullOr(Execution.Failure),
	result: Schema.optionalKey(
		Schema.Struct({ result: Schema.Json, isFailure: Schema.Boolean }),
	),
})

const appParts = Effect.fn("DevelopmentModel.appParts")(function* (
	options: LanguageModel.ProviderOptions,
) {
	const { index, text } = yield* currentInput(options.prompt)
	const notice = Str.startsWith("[OpenBot] ")(text)
		? Schema.decodeOption(Schema.fromJsonString(ToolNotice))(
				Str.slice(10)(text),
			)
		: Option.none()
	if (Option.isSome(notice) && notice.value.status !== "completed")
		return textParts(
			"mock-app",
			`The App call ended with ${notice.value.status}. Error: ${notice.value.failure?.errorId ?? "none"}.`,
		)
	const found = Option.orElse(
		lastToolResult(options.prompt, index, Str.startsWith("openbot_")),
		() =>
			Option.flatMap(notice, (notice) => Option.fromUndefinedOr(notice.result)),
	)
	if (Option.isSome(found)) {
		const result = found.value
		if (Predicate.hasProperty(result.result, "background"))
			return textParts(
				"mock-app",
				"The simulated App call waits for a decision.",
			)
		const answer = Schema.decodeUnknownOption(AppAnswer)(result.result)
		if (Option.isSome(answer)) {
			const { source, outcome, failure } = answer.value
			return textParts(
				"mock-app",
				outcome === null
					? `The App call has no result. Error: ${failure?.errorId ?? "none"}.`
					: Match.value(outcome).pipe(
							Match.tag(
								"Completed",
								({ result }) =>
									`Simulated App result from ${source.connectionName}: ${JSON.stringify(result)}`,
							),
							Match.tag(
								"InputRequired",
								() => "The simulated App needs more input.",
							),
							Match.tag(
								"Failed",
								({ failure }) =>
									`The App call failed. Error: ${failure.errorId}.`,
							),
							Match.exhaustive,
						),
			)
		}
		const value = yield* Schema.decodeUnknownEffect(AppExecution.ToolResult)(
			result.result,
		).pipe(
			Effect.mapError((error) =>
				invalidRequest(
					`The simulated App result does not match its contract: ${error.message}`,
				),
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
						"Choose which App account should do this task, or finish its configuration and authorization in My Apps. Then say in this Chat that the work can go on.",
				),
				Match.tag("AppAssistanceFailed", ({ message }) => message),
				Match.exhaustive,
			),
		)
	}
	const choices = Arr.filter(options.tools, (tool) =>
		Option.exists(
			Option.fromUndefinedOr(tool.description),
			Str.includes(" / read_document."),
		),
	)
	const lowerText = Str.toLocaleLowerCase("en-US")(text)
	const selected = Arr.filter(choices, (tool) =>
		pipe(
			Option.fromUndefinedOr(tool.description),
			Option.flatMap((description) =>
				Arr.get(Str.split(description, " / "), 1),
			),
			Option.exists((account) =>
				Str.includes(Str.toLocaleLowerCase("en-US")(account))(lowerText),
			),
		),
	)
	const tool =
		selected.length === 1
			? selected[0]
			: choices.length === 1
				? choices[0]
				: undefined
	if (tool === undefined) {
		const assistance = Arr.findFirst(
			options.tools,
			(candidate) =>
				candidate.name ===
				(choices.length === 0
					? Assistance.names.search
					: Assistance.names.access),
		)
		if (Option.isNone(assistance))
			return textParts(
				"mock-app",
				"App discovery is unavailable in this host. Add an App by address and say in this Chat that the work can go on.",
			)
		return [
			Response.makePart("tool-call", {
				id: "development-app-assistance-" + index,
				name: assistance.value.name,
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
				Match.when("mock-failure", () => Effect.fail(scenarioFailure())),
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
			Stream.succeed(delta(Str.slice(0, 12)(text))).pipe(
				Stream.concat(
					Stream.fromEffect(
						Effect.as(
							Effect.sleep("5 seconds"),
							delta(Str.slice(12, 24)(text)),
						),
					),
				),
				Stream.concat(
					Stream.fromEffect(
						Effect.as(Effect.sleep("5 seconds"), delta(Str.slice(24)(text))),
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
							).pipe(Stream.concat(Stream.fail(scenarioFailure()))),
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
		Rec.map(descriptions, (_, scenario) =>
			Effect.map(Layer.build(layer(scenario)), (context) =>
				Context.get(context, LanguageModel.LanguageModel),
			),
		),
	)
	const resolve = (requested: Config.Selection) =>
		Effect.gen(function* () {
			if (requested.provider !== provider)
				return yield* Config.ModelConfigurationError.make({
					reason: "provider-not-found",
					message: "The development provider is unavailable",
				})
			if (
				requested.reasoningEffort !== undefined ||
				requested.serviceTier !== undefined
			)
				return yield* Config.ModelConfigurationError.make({
					reason: "unsupported-option",
					message:
						"Development scenarios do not support reasoning effort or service tiers",
				})
			const scenario = yield* Schema.decodeUnknownEffect(Scenario)(
				requested.model,
			).pipe(
				// A model name that is not a scenario is the only way to fail here.
				Effect.mapError((error) =>
					Config.ModelConfigurationError.make({
						reason: "model-not-found",
						message: `The development scenario is unavailable: ${error.message}`,
					}),
				),
			)
			return models[scenario]
		})
	return {
		/** Every organization of a development platform can use the simulated models. */
		builtinModels: { ...catalog, resolve, defaultModel: selection },
	}
})
