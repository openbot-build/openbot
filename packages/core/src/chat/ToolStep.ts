import { Array as Arr, Effect, HashMap, Option, Schema, Stream } from "effect"
import {
	Prompt,
	Response,
	type AiError,
	type Tool,
	type Toolkit,
} from "effect/ai"
import type { Position } from "./ModelStep.ts"
import * as ChatState from "./ChatState.ts"

/** The host saves the model result before it asks to run these calls. */
export const pending = (prompt: Prompt.Prompt) => {
	const calls = ChatState.pendingCalls(prompt)
	return Arr.flatMap(prompt.content, (message) =>
		message.role === "assistant"
			? Arr.filter(
					message.content,
					(part): part is Prompt.ToolCallPart =>
						part.type === "tool-call" &&
						Option.exists(HashMap.get(calls, part.id), (call) => call === part),
				)
			: [],
	)
}

export const decisionFor = (prompt: Prompt.Prompt, call: string) =>
	HashMap.get(ChatState.toolCallStates(prompt), call).pipe(
		Option.flatMap((current) => Option.fromUndefinedOr(current.answer)),
	)

const failure = (call: Prompt.ToolCallPart, result: Schema.Json) =>
	Response.makePart("tool-result", {
		id: call.id,
		name: call.name,
		providerExecuted: false,
		result,
		encodedResult: result,
		isFailure: true,
		preliminary: false,
	})

export interface Input<Tools extends Record<string, Tool.Any>> {
	readonly call: Prompt.ToolCallPart
	readonly toolkit: Toolkit.WithHandler<Tools>
}
/** The host can save a tool result without changing approval or model rules. */
export interface Run<E = never> {
	<Tools extends Record<string, Tool.Any>>(
		position: Position,
		input: Input<Tools>,
	): Stream.Stream<
		Response.StreamPart<Record<string, Tool.Any>>,
		E | Tool.HandlerError<Tools[keyof Tools]> | AiError.AiError,
		Tool.HandlerServices<Tools[keyof Tools]>
	>
}

/** Resume checks saved work before the current tool and approval rules. The host checks access. */
export interface Executor<E = never> {
	readonly run: Run<E>
	readonly resume?: <Tools extends Record<string, Tool.Any>>(
		position: Position,
		input: Input<Tools>,
	) => Effect.Effect<
		Option.Option<
			Stream.Stream<
				Response.StreamPart<Record<string, Tool.Any>>,
				E | Tool.HandlerError<Tools[keyof Tools]> | AiError.AiError,
				Tool.HandlerServices<Tools[keyof Tools]>
			>
		>,
		E
	>
}

/** The memory adapter calls the handler in the caller's Scope. */
export const execute: Run = (_, { call, toolkit }) =>
	Stream.unwrap(
		Effect.map(
			toolkit.handle(
				call.name,
				call.params as Tool.ParametersEncoded<(typeof toolkit.tools)[string]>,
				call.id,
			),
			(parts) =>
				parts.pipe(
					Stream.map((result) =>
						Response.makePart("tool-result", {
							id: call.id,
							name: call.name,
							providerExecuted: false,
							result: result.result,
							encodedResult: result.encodedResult,
							isFailure: result.isFailure,
							preliminary: result.preliminary,
							...(result.modelOutput === undefined
								? {}
								: { modelOutput: result.modelOutput }),
						}),
					),
				),
		),
	)

/** Resolve one saved call. The host still checks current access at the call boundary. */
export const run = <Tools extends Record<string, Tool.Any>, E = never>(
	input: Input<Tools> & {
		readonly position: Position
		readonly execute?: Executor<E>
		readonly prompt: Prompt.Prompt
		readonly finishReason?: Response.FinishReason
	},
) =>
	Stream.unwrap(
		Effect.gen(function* (): Effect.fn.Return<
			Stream.Stream<
				Response.StreamPart<Record<string, Tool.Any>>,
				E | Tool.HandlerError<Tools[keyof Tools]> | AiError.AiError,
				Tool.HandlerServices<Tools[keyof Tools]>
			>,
			E | Schema.SchemaError | AiError.AiError,
			Tool.HandlerServices<Tools[keyof Tools]>
		> {
			const { call, prompt, toolkit } = input

			if (
				input.finishReason !== undefined &&
				!Arr.contains(["stop", "tool-calls", "pause"], input.finishReason)
			)
				return Stream.succeed(
					failure(call, {
						type: "execution-interrupted",
						reason: `The call did not run because the model ended with reason "${input.finishReason}".`,
					}),
				)
			if (input.execute?.resume !== undefined) {
				const saved = yield* input.execute.resume(input.position, {
					call,
					toolkit,
				})
				if (Option.isSome(saved)) return saved.value
			}
			if (
				Arr.some(
					ChatState.openApprovals(prompt),
					(request) => request.toolCall.id === call.id,
				)
			)
				return Stream.empty
			const decision = decisionFor(prompt, call.id)
			if (Option.isSome(decision) && !decision.value.approved)
				return Stream.succeed(
					failure(call, {
						type: "execution-denied",
						reason: decision.value.reason ?? "The call was denied.",
					}),
				)
			const tool = toolkit.tools[call.name]
			if (tool === undefined)
				return Stream.succeed(
					failure(call, {
						error: `The call did not run, because the tool ${call.name} is not open now.`,
					}),
				)
			if (Option.isNone(decision)) {
				const needsApproval = tool.needsApproval
				let required = needsApproval === true
				if (typeof needsApproval === "function") {
					const schema = tool.parametersSchema as Schema.Codec<
						unknown,
						unknown,
						Tool.HandlerServices<Tools[keyof Tools]>
					>
					const params = yield* Schema.decodeUnknownEffect(schema)(call.params)
					const result = needsApproval(params, {
						toolCallId: call.id,
						messages: prompt.content,
					})
					required = Effect.isEffect(result) ? yield* result : result
				}
				if (required)
					return Stream.succeed(
						Response.makePart("tool-approval-request", {
							// A replay names the same decision without a second random ID.
							approvalId: yield* Schema.encodeEffect(
								Schema.fromJsonString(
									Schema.Tuple([Schema.String, Schema.String]),
								),
							)([input.position.item, call.id]),
							toolCallId: call.id,
						}),
					)
			}
			return (input.execute?.run ?? execute)(input.position, { call, toolkit })
		}),
	)
