import { Data, Schema, type Effect } from "effect"
import * as ModelRuntime from "./Model.ts"
import * as ProviderRuntime from "./Provider.ts"
import type * as Chat from "../chat/Chat.ts"
import type * as ChatStore from "../store/ChatStore.ts"

/** Provider catalog data that can be serialized. Executable providers live in Provider. */
export const Provider = Schema.Struct({
	id: ProviderRuntime.Id,
	name: Schema.String,
	endpoint: Schema.optional(Schema.String),
})
export type Provider = typeof Provider.Type

export class Selection extends Schema.TaggedClass<
	Selection,
	{ readonly brand: unique symbol }
>()("Config.Selection", {
	provider: ProviderRuntime.Id,
	model: ModelRuntime.Id,
	reasoningEffort: Schema.optional(Schema.String),
	serviceTier: Schema.optional(Schema.String),
}) {}

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

const CompactionSchema = Schema.TaggedUnion({
	Native: {},
	NonNative: {
		model: Schema.optional(Selection),
		keepRecentMessages: Schema.optional(PositiveInt),
	},
})
export type Compaction = typeof CompactionSchema.Type
export const Compaction = Data.taggedEnum<Compaction>()

export const ReasoningLevel = Schema.Struct({
	effort: Schema.NonEmptyString,
	description: Schema.String,
})
export const ServiceTier = Schema.Struct({
	id: Schema.NonEmptyString,
	name: Schema.String,
	description: Schema.String,
})

export interface ContextLimits {
	readonly contextWindow: number
	readonly inputTokens: number
	readonly autoCompactTokens: number
}

/** Model catalog data that can be serialized. Executable models live in Model. */
export class Model extends Schema.TaggedClass<
	Model,
	{ readonly brand: unique symbol }
>()("Config.Model", {
	provider: ProviderRuntime.Id,
	id: ModelRuntime.Id,
	name: Schema.String,
	description: Schema.optional(Schema.String),
	visibility: Schema.optional(Schema.Literals(["list", "hide", "none"])),
	priority: Schema.optional(Schema.Int),
	defaultReasoningLevel: Schema.optional(Schema.NonEmptyString),
	reasoningLevels: Schema.optional(Schema.Array(ReasoningLevel)),
	defaultServiceTier: Schema.optional(Schema.NonEmptyString),
	serviceTierOptions: Schema.optional(Schema.Array(ServiceTier)),
	maxContextWindow: Schema.optional(PositiveInt),
	effectiveContextWindowPercent: Schema.optional(
		Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
	),
	effectiveContextWindow: Schema.optional(PositiveInt),
	instructionsTemplate: Schema.optional(Schema.String),
	supportVerbosity: Schema.optional(Schema.Boolean),
	defaultVerbosity: Schema.optional(Schema.Literals(["low", "medium", "high"])),
	supportsReasoningSummaryParameter: Schema.optional(Schema.Boolean),
	defaultReasoningSummary: Schema.optional(
		Schema.Literals(["auto", "concise", "detailed", "none"]),
	),
	reasoningEfforts: Schema.Array(Schema.String),
	serviceTiers: Schema.Array(Schema.String),
	maxInputTokens: Schema.optional(PositiveInt),
	maxOutputTokensLimit: Schema.optional(PositiveInt),
	maxOutputTokens: Schema.optional(PositiveInt),
	temperature: Schema.optional(Schema.Finite),
	topP: Schema.optional(Schema.Finite),
	tokenCounting: Schema.optional(Schema.Literals(["native", "estimate"])),
	contextWindow: Schema.optional(PositiveInt),
	compaction: Schema.optional(CompactionSchema),
	autoCompactTokenLimit: Schema.optional(PositiveInt),
}) {}

/** `build` does the work. `plan` looks things up and writes a plan first. */
export const Mode = Schema.Literals(["build", "plan"])
export type Mode = typeof Mode.Type

/** Why a model selection or model setting is not valid. */
export const ModelConfigurationReason = Schema.Literals([
	"provider-not-found",
	"model-not-found",
	"unsupported-option",
	"unavailable",
	/** No model is chosen. */
	"missing",
])
export type ModelConfigurationReason = typeof ModelConfigurationReason.Type
/** Why a selection does not fit the catalog, or why there is no selection. */
export const SelectionReason = ModelConfigurationReason.pick([
	"provider-not-found",
	"model-not-found",
	"unsupported-option",
	"missing",
])
export type SelectionReason = typeof SelectionReason.Type

export class ModelConfigurationError extends Schema.TaggedError<
	ModelConfigurationError,
	{ readonly brand: unique symbol }
>()("ModelConfigurationError", {
	reason: ModelConfigurationReason,
	message: Schema.String,
}) {}

export interface ModelConfigurationOperations<
	ReadError = ModelConfigurationError,
	SelectError = ModelConfigurationError,
	SelectServices = never,
> {
	readonly get: Effect.Effect<Selection, ReadError>
	readonly select: (
		selection: Selection,
	) => Effect.Effect<Selection, SelectError, SelectServices>
	readonly listProviders: Effect.Effect<
		ReadonlyArray<Provider>,
		ModelConfigurationError
	>
	readonly listModels: (
		provider?: ProviderRuntime.Id,
	) => Effect.Effect<ReadonlyArray<Model>, ModelConfigurationError>
}

export interface ModelConfigurationOptions<P = {}> {
	readonly store: Pick<ChatStore.Store<P>, "read" | "modifyEffect">
	readonly models: ReadonlyArray<Model>
	readonly chat: Chat.Id
	readonly providers: ReadonlyArray<Provider>
}

export type RuntimeModelConfiguration = ModelConfigurationOperations<
	Chat.ChatNotFound | ChatStore.ChatStoreError | ModelConfigurationError,
	| Chat.ChatNotFound
	| Chat.Conflict
	| ChatStore.ChatStoreError
	| ModelConfigurationError,
	never
>

export class ExecutionModeError extends Schema.TaggedError<
	ExecutionModeError,
	{ readonly brand: unique symbol }
>()("ExecutionModeError", {
	reason: Schema.Literals(["chat-not-found", "unavailable"]),
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

export interface ExecutionModeOperations<
	ReadError = ExecutionModeError,
	WriteError = ExecutionModeError,
	WriteServices = never,
> {
	readonly get: Effect.Effect<Mode, ReadError>
	readonly set: (mode: Mode) => Effect.Effect<Mode, WriteError, WriteServices>
}

export interface ExecutionModeOptions<P = {}> {
	readonly store: Pick<ChatStore.Store<P>, "read" | "modifyEffect">
	readonly chat: Chat.Id
}

export type RuntimeExecutionMode = ExecutionModeOperations<
	Chat.ChatNotFound | ChatStore.ChatStoreError,
	Chat.ChatNotFound | Chat.Conflict | ChatStore.ChatStoreError,
	never
>
