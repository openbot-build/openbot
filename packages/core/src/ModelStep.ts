import {
	Array as Arr,
	Chunk,
	Effect,
	HashMap,
	Option,
	Schema,
	Stream,
} from "effect"
import {
	LanguageModel,
	Prompt,
	Response,
	type AiError,
	type Tool,
	type Toolkit,
} from "effect/ai"

import * as ChatState from "./ChatState.ts"
import type * as Chat from "./Chat.ts"
import type * as Turn from "./Turn.ts"
import type * as Item from "./Item.ts"

/** A stream without a finish part has no confirmed model result. */
export class Incomplete extends Schema.TaggedError<
	Incomplete,
	{ readonly brand: unique symbol }
>()("ModelStepIncomplete", {}) {}
/** Provider error parts are failures even when a finish part follows them. */
export class Failed extends Schema.TaggedError<
	Failed,
	{ readonly brand: unique symbol }
>()("ModelStepFailed", {
	errors: Schema.Array(Schema.Unknown),
	usage: Schema.NullOr(Response.Usage),
}) {}
/** Tool results belong to the host, and must be saved before another model step. */
export class UnresolvedCalls extends Schema.TaggedError<
	UnresolvedCalls,
	{ readonly brand: unique symbol }
>()("ModelStepUnresolvedCalls", { calls: Schema.Array(Schema.String) }) {}
/** A saved step needs a finish part and no provider failure. */
export const requireFinish = (
	finish: Option.Option<Response.FinishPart>,
	errors: ReadonlyArray<unknown>,
): Effect.Effect<Response.FinishPart, Incomplete | Failed> => {
	if (
		errors.length > 0 ||
		(Option.isSome(finish) && finish.value.reason === "error")
	)
		return Effect.fail(
			Failed.make({
				errors,
				usage: Option.isSome(finish) ? finish.value.usage : null,
			}),
		)
	return Effect.fromOption(finish).pipe(
		Effect.catchTag("NoSuchElementError", () =>
			Effect.fail(Incomplete.make({})),
		),
	)
}

export const Call = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	params: Schema.Json,
})
export type Call = typeof Call.Type

/** Save this result before starting its tool calls. A retry gets a new attempt. */
export const Result = Schema.Struct({
	output: Prompt.Prompt,
	calls: Schema.Array(Call),
	finishReason: Response.FinishReason,
	usage: Response.Usage,
})
export type Result = typeof Result.Type

/** A host can save a model call and its attempts without owning the model loop. */
export interface Position {
	readonly chat: Chat.Id
	readonly turn: Turn.Id
	readonly step: number
	readonly item: Item.Id
}
export interface Input<Tools extends Record<string, Tool.Any>> {
	readonly prompt: Prompt.Prompt
	readonly toolkit: Toolkit.Toolkit<Tools>
	readonly toolChoice?: LanguageModel.GenerateTextOptions<Tools>["toolChoice"]
}
export type Failure =
	Incomplete | Failed | UnresolvedCalls | Schema.SchemaError | AiError.AiError
export interface Executor<E = never> {
	<Tools extends Record<string, Tool.Any>>(
		position: Position,
		input: Input<Tools>,
		onPart: (
			part: Response.StreamPart<Tools, "deferred">,
		) => Effect.Effect<void>,
	): Effect.Effect<
		Result,
		Failure | E,
		| LanguageModel.LanguageModel
		| Tool.ParametersEncodingServices<Tools[keyof Tools]>
	>
}

/**
 * One provider step, with no local tool execution. The caller owns the model's
 * scope, the attempt, text events and the commit that makes the result durable.
 */
export const run = Effect.fn("ModelStep.run")(function* <
	Tools extends Record<string, Tool.Any>,
	E,
	R,
>(
	input: Input<Tools>,
	onPart: (
		part: Response.StreamPart<Tools, "deferred">,
	) => Effect.Effect<void, E, R>,
) {
	const pending = ChatState.pendingCalls(input.prompt)
	// Effect AI resolves old approved calls even with disableToolCallResolution.
	// Reject unfinished calls here so that a model step can never run a tool.
	if (HashMap.size(pending) > 0)
		return yield* UnresolvedCalls.make({
			calls: Arr.fromIterable(HashMap.keys(pending)),
		})
	const model = yield* LanguageModel.LanguageModel
	const parts = yield* model
		.streamText({
			...input,
			disableToolCallResolution: true,
			toolCallValidation: "deferred",
		})
		.pipe(
			Stream.tap(onPart),
			Stream.runFold(
				() => Chunk.empty<Response.StreamPart<Tools, "deferred">>(),
				(parts, part) => Chunk.append(parts, part),
			),
		)
	const all = Arr.fromIterable(parts)
	const finish = yield* requireFinish(
		Arr.findLast(all, (part) => part.type === "finish"),
		Arr.map(
			Arr.filter(all, (part) => part.type === "error"),
			(part) => part.error,
		),
	)
	const calls = yield* Effect.forEach(
		Arr.filter(
			all,
			(part) => part.type === "tool-call" && !part.providerExecuted,
		),
		(part) => Schema.decodeUnknownEffect(Call)(part),
	)
	return Result.make({
		output: Prompt.fromResponseParts(all),
		calls,
		finishReason: finish.reason,
		usage: finish.usage,
	})
})

/** The standalone host runs a model step in its current process. */
export const execute: Executor = (_position, input, onPart) =>
	run(input, onPart)
