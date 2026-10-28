import { type Developers, Execution } from "@openbot-build/domain"
import type { Paused } from "../execution/Admission.ts"
import type { Definition } from "./ToolDefinitions.ts"
import { ChatState, type ModelStep, ToolStep } from "@openbot-build/core"
import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Option,
	Queue,
	Schema,
	Stream,
} from "effect"
import { Prompt, Response, Tool } from "effect/ai"
import { Idempotent, Local, SavedResult } from "../plugins/ToolEntry.ts"
import { CallContext } from "../execution/CallContext.ts"
import { Calls } from "../execution/Calls.ts"
import { Store, type Fence } from "../execution/Store.ts"

/** A tool stream must give a final result before it can be saved as complete. */
export class Incomplete extends Schema.TaggedError<
	Incomplete,
	{ readonly brand: unique symbol }
>()("ToolResultIncomplete", {}) {}

const Output = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	result: Schema.optionalKey(Schema.Json),
	isFailure: Schema.Boolean,
	preliminary: Schema.Boolean,
	modelOutput: Schema.optionalKey(Schema.Array(Prompt.ToolModelOutputPart)),
})
export const outputCodec = Schema.toCodecJson(Output)
export const stepId = (item: string, call: string) =>
	`tool:${item.length}:${item}${call}`

type Failure =
	| Paused
	| Execution.Forbidden
	| Execution.NotFound
	| Execution.Conflict
	| Execution.StorageError
	| Execution.Failure
	| Schema.SchemaError
	| Execution.OutcomeUnknown

/** An old approval cannot replace the current action policy. No call has been sent yet. */
export const beforeSend = (
	tool: Tool.Any,
	call: Prompt.ToolCallPart,
	prompt: Prompt.Prompt,
) =>
	Effect.gen(function* () {
		const decision = ToolStep.decisionFor(prompt, call.id)
		if (
			Arr.some(
				ChatState.openApprovals(prompt),
				(request) => request.toolCall.id === call.id,
			) ||
			Option.exists(decision, (answer) => !answer.approved)
		)
			return yield* Execution.Forbidden.make({})
		const check = tool.needsApproval
		if (check === true && !Option.exists(decision, (answer) => answer.approved))
			return yield* Execution.Forbidden.make({})
		if (typeof check === "function") {
			const schema = tool.parametersSchema as Schema.Codec<unknown, unknown>
			const params = yield* Schema.decodeUnknownEffect(schema)(call.params)
			const answer = check(params, {
				toolCallId: call.id,
				messages: prompt.content,
			})
			const required = Effect.isEffect(answer) ? yield* answer : answer
			if (required) return yield* Execution.Forbidden.make({})
		}
	})

export interface Service {
	readonly executor: (fence: Fence) => ToolStep.Executor<Failure>
	readonly run: <Tools extends Record<string, Tool.Any>>(
		fence: Fence,
		position: ModelStep.Position,
		input: ToolStep.Input<Tools>,
		publish: (
			part: Response.StreamPart<Record<string, Tool.Any>>,
		) => Effect.Effect<void>,
		approve?:
			Effect.Effect<void, Execution.Forbidden | Schema.SchemaError> | undefined,
		definition?: Definition | undefined,
	) => Effect.Effect<
		Schema.Json,
		Failure,
		Exclude<
			Exclude<Tool.HandlerServices<Tools[keyof Tools]>, CallContext>,
			never
		>
	>
	readonly saved: (
		fence: Fence,
		position: ModelStep.Position,
		call: Prompt.ToolCallPart,
	) => Effect.Effect<
		Option.Option<Schema.Json>,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.OutcomeUnknown
		| Paused
		| Developers.StorageFailure
		| {
				errorId: Execution.ErrorId
				category: Execution.Failure["category"]
		  }
	>
}

export class ToolSteps extends Context.Service<ToolSteps, Service>()(
	"@openbot-build/openbot/chats/ToolSteps",
) {}

const make = Effect.gen(function* () {
	const calls = yield* Calls
	const store = yield* Store
	const run = Effect.fn("ToolSteps.run")(function* <
		Tools extends Record<string, Tool.Any>,
	>(
		fence: Fence,
		position: ModelStep.Position,
		input: ToolStep.Input<Tools>,
		publish: (
			part: Response.StreamPart<Record<string, Tool.Any>>,
		) => Effect.Effect<void>,
		approve?: Effect.Effect<void, Execution.Forbidden | Schema.SchemaError>,
		definition?: Definition,
	) {
		yield* calls.authorize(fence, "replay")
		const tool = input.toolkit.tools[input.call.name]
		if (tool === undefined)
			return yield* Execution.Conflict.make({ id: fence.id })
		const step = stepId(position.item, input.call.id)
		const request = yield* Schema.decodeUnknownEffect(Schema.Json)({
			chat: position.chat,
			turn: position.turn,
			item: position.item,
			call: input.call.id,
			name: input.call.name,
			params: input.call.params,
			...(definition?.inputState === undefined
				? {}
				: { inputState: definition.inputState }),
			parameters: definition?.parameters ?? Tool.getJsonSchema(tool),
		})
		const call = Context.get(tool.annotations, Tool.Readonly)
			? yield* store.readAttempt(fence, step, request)
			: yield* store.writeAttempt(
					fence,
					step,
					request,
					Context.get(tool.annotations, Local)
						? "local"
						: Context.get(tool.annotations, Idempotent)
							? "idempotent"
							: "never",
				)
		const recover = Context.get(tool.annotations, SavedResult)
		const outcome = yield* calls.invoke(
			fence,
			{
				...call,
				...(recover === undefined
					? {}
					: {
							savedResult: (id: Execution.CallId) =>
								recover(id, input.call.params).pipe(
									Effect.flatMap(
										Option.match({
											onNone: () => Effect.succeedNone,
											onSome: (result) =>
												Schema.encodeEffect(outputCodec)({
													id: input.call.id,
													name: input.call.name,
													result,
													isFailure: false,
													preliminary: false,
												}).pipe(Effect.asSome),
										}),
									),
								),
						}),
				resultEvents: (output) => [
					{ _tag: "ToolOutput", step, attempt: call.attempt, output },
				],
			},
			() =>
				Effect.gen(function* () {
					let final: Option.Option<Schema.Json> = Option.none()
					yield* ToolStep.execute(position, input).pipe(
						Stream.provideService(CallContext, {
							fence,
							id: call.id,
							...(definition?.inputState === undefined
								? {}
								: { inputState: definition.inputState }),
						}),
						Stream.runForEach((part) =>
							Effect.gen(function* () {
								if (part.type !== "tool-result") return
								const output = yield* Schema.encodeEffect(outputCodec)({
									id: part.id,
									name: part.name,
									...(part.encodedResult === undefined
										? {}
										: {
												result: yield* Schema.decodeUnknownEffect(Schema.Json)(
													part.encodedResult,
												),
											}),
									isFailure: part.isFailure,
									preliminary: part.preliminary,
									...(part.modelOutput === undefined
										? {}
										: { modelOutput: part.modelOutput }),
								})
								if (part.preliminary) {
									yield* store.commit(
										fence,
										{
											events: [
												{
													_tag: "ToolOutput",
													step,
													attempt: call.attempt,
													output,
												},
											],
										},
										Effect.void,
									)
									yield* publish(part)
								} else {
									final = Option.some(output)
								}
							}),
						),
					)
					return yield* Effect.fromOption(final).pipe(
						Effect.catchTag("NoSuchElementError", () =>
							Effect.fail(Incomplete.make({})),
						),
					)
				}),
			approve,
		)
		if (outcome._tag === "Unknown")
			return yield* Execution.OutcomeUnknown.make({ callId: outcome.callId })
		const output = yield* Schema.decodeEffect(outputCodec)(outcome.result)
		yield* publish(
			Response.makePart("tool-result", {
				...output,
				result: output.result,
				encodedResult: output.result,
				providerExecuted: false,
			}),
		)
		return outcome.result
	})
	/** Replay does not open a connection or require the old tool definition. */
	const saved = Effect.fn("ToolSteps.saved")(function* (
		fence: Fence,
		position: ModelStep.Position,
		call: Prompt.ToolCallPart,
	) {
		yield* calls.authorize(fence, "replay")
		const step = stepId(position.item, call.id)
		const prior = yield* store.latestCall(fence, step)
		if (Option.isNone(prior)) return Option.none<Schema.Json>()
		const request = yield* Schema.decodeUnknownEffect(
			Schema.Struct({
				chat: Schema.String,
				turn: Schema.String,
				item: Schema.String,
				call: Schema.String,
				name: Schema.String,
				params: Schema.Json,
			}),
		)(prior.value.input)
		if (
			!Schema.toEquivalence(Schema.Json)(request, {
				chat: position.chat,
				turn: position.turn,
				item: position.item,
				call: call.id,
				name: call.name,
				params: yield* Schema.decodeUnknownEffect(Schema.Json)(call.params),
			})
		)
			return yield* Execution.Conflict.make({ id: fence.id })
		const record =
			prior.value.status === "sending" && prior.value.retry === "never"
				? yield* store.sending(fence, prior.value.id)
				: prior.value
		if (record.status === "outcome_unknown" && record.retry !== "read_only")
			return yield* Execution.OutcomeUnknown.make({ callId: record.id })
		if (record.status !== "completed") return Option.none<Schema.Json>()
		const outcome = yield* calls.invoke(
			fence,
			{
				...record,
				resultEvents: (output) => [
					{ _tag: "ToolOutput", step, attempt: record.attempt, output },
				],
			},
			() => Effect.die("A saved tool result must not send a call."),
		)
		if (outcome._tag === "Unknown")
			return yield* Execution.OutcomeUnknown.make({ callId: outcome.callId })
		return Option.some(outcome.result)
	})
	const executor = (fence: Fence): ToolStep.Executor<Failure> => ({
		resume: (position, input) =>
			saved(fence, position, input.call).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.succeedNone,
						onSome: (value) =>
							Schema.decodeEffect(outputCodec)(value).pipe(
								Effect.map((output) =>
									Option.some(
										Stream.succeed(
											Response.makePart("tool-result", {
												...output,
												result: output.result,
												encodedResult: output.result,
												providerExecuted: false,
											}),
										),
									),
								),
							),
					}),
				),
			),
		run: (position, input) =>
			Stream.callback(
				(queue) =>
					run(fence, position, input, (part) =>
						Queue.offer(queue, part).pipe(Effect.asVoid),
					).pipe(Effect.andThen(Queue.end(queue))),
				{ bufferSize: 128 },
			),
	})
	return ToolSteps.of({ executor, run, saved })
})

/** Server tool results are JSON. The call log seals them before the Chat checkpoint. */

export const layer = Layer.effect(ToolSteps, make)
