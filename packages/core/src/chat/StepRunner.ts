import {
	Array as Arr,
	Effect,
	Option,
	Queue,
	Ref,
	Stream,
	type Schema,
} from "effect"
import {
	Prompt,
	type AiError,
	type LanguageModel,
	type Response,
	type Tool,
	type Toolkit,
} from "effect/ai"
import type * as Chat from "./Chat.ts"
import type * as ChatStore from "../store/ChatStore.ts"
import * as Item from "./Item.ts"
import * as Turn from "./Turn.ts"
import * as TurnState from "./TurnState.ts"
import * as ModelStep from "./ModelStep.ts"
import * as ToolStep from "./ToolStep.ts"

/** Model output commits before tools. Each tool result commits before the next model. */
export const make = <
	P,
	Tools extends Record<string, Tool.Any>,
	E = never,
	ToolE = never,
>(input: {
	readonly executeModel?: ModelStep.Executor<E>
	readonly executeTool?: ToolStep.Executor<ToolE>
	readonly store: ChatStore.Store<P>
	readonly chat: Chat.Id
	readonly turn: Turn.Id
	readonly step: number
	readonly item: Item.Id
	readonly prompt: Prompt.Prompt
	readonly history: Ref.Ref<Prompt.Prompt>
	readonly toolkit: Toolkit.Toolkit<Tools>
	readonly handlers: Toolkit.WithHandler<Tools>
	readonly toolChoice?: LanguageModel.GenerateTextOptions<Tools>["toolChoice"]
	readonly concurrency?: LanguageModel.GenerateTextOptions<Tools>["concurrency"]
}) => {
	const read = Effect.gen(function* () {
		const view = yield* input.store.read(input.chat)
		const turn = yield* TurnState.requireOpen(view, input.turn)
		const saved = turn.pendingStep
		if (
			saved === undefined ||
			saved.step !== input.step ||
			saved.item !== input.item
		)
			return yield* Turn.Conflict.make({
				chat: input.chat,
				turn: input.turn,
				message: "The saved step does not match this step",
			})
		return saved
	})
	const save = (change: (saved: Turn.PendingStep) => Turn.PendingStep) =>
		input.store.modifyEffect({
			chat: input.chat,
			update: (view) =>
				Effect.gen(function* () {
					const turn = yield* TurnState.requireOpen(view, input.turn)
					const saved = turn.pendingStep ?? {
						step: input.step,
						item: input.item,
						input: input.prompt,
						before: Prompt.empty,
						after: Prompt.empty,
					}
					if (saved.step !== input.step || saved.item !== input.item)
						return yield* Turn.Conflict.make({
							chat: input.chat,
							turn: input.turn,
							message: "Another step is still open",
						})
					return [
						undefined,
						Option.some({
							chat: { turn: { ...turn, pendingStep: change(saved) } },
						}),
					] as const
				}),
		})

	const result = Effect.gen(function* () {
		const saved = yield* read
		if (saved.model === undefined) return yield* ModelStep.Incomplete.make({})
		return {
			model: saved.model,
			added: Prompt.concat(
				saved.before,
				Prompt.concat(saved.model.output, saved.after),
			),
		}
	})
	const stream = Stream.callback<
		Response.StreamPart<Record<string, Tool.Any>>,
		| E
		| ToolE
		| Chat.RuntimeError
		| ModelStep.Incomplete
		| ModelStep.Failed
		| ModelStep.UnresolvedCalls
		| Schema.SchemaError
		| AiError.AiError
		| Tool.HandlerError<Tools[keyof Tools]>,
		LanguageModel.LanguageModel | Tool.HandlerServices<Tools[keyof Tools]>
	>(
		(queue) =>
			Effect.gen(function* () {
				yield* save((saved) => saved)
				const emit = (part: Response.StreamPart<Record<string, Tool.Any>>) =>
					Queue.offer(queue, part).pipe(Effect.asVoid)
				const tools = (phase: "before" | "after") =>
					Effect.gen(function* () {
						const saved = yield* read
						const prompt = Turn.stepPrompt(saved)
						yield* Stream.mergeAll(
							Arr.map(ToolStep.pending(prompt), (call) =>
								ToolStep.run({
									position: {
										chat: input.chat,
										turn: input.turn,
										step: input.step,
										item: input.item,
									},
									...(input.executeTool === undefined
										? {}
										: { execute: input.executeTool }),
									prompt,
									call,
									toolkit: input.handlers,
									...(phase === "after" && saved.model !== undefined
										? { finishReason: saved.model.finishReason }
										: {}),
								}).pipe(
									Stream.tap((part) =>
										Effect.gen(function* () {
											if (part.type !== "tool-result" || !part.preliminary) {
												// Save before publishing. The host wraps outside writes in its call log.
												yield* save((saved) => ({
													...saved,
													[phase]: Prompt.concat(
														saved[phase],
														Prompt.fromResponseParts([part]),
													),
												}))
												yield* Ref.set(
													input.history,
													Turn.stepPrompt(yield* read),
												)
											}
											yield* emit(part)
										}),
									),
								),
							),
							{ concurrency: input.concurrency ?? "unbounded" },
						).pipe(Stream.runDrain)
					})
				let saved = yield* read
				if (saved.model === undefined) {
					yield* tools("before")
					saved = yield* read
					const model = yield* (input.executeModel ?? ModelStep.execute)(
						{
							chat: input.chat,
							turn: input.turn,
							step: input.step,
							item: input.item,
						},
						{
							prompt: Turn.stepPrompt(saved),
							toolkit: input.toolkit,
							...(input.toolChoice === undefined
								? {}
								: { toolChoice: input.toolChoice }),
						},
						emit,
					)
					yield* save((saved) => ({ ...saved, model }))
					yield* Ref.set(input.history, Turn.stepPrompt(yield* read))
				}
				yield* tools("after")
				yield* Ref.set(input.history, Turn.stepPrompt(yield* read))
				yield* Queue.end(queue)
			}),
		{ bufferSize: 128 },
	)
	return { stream, result }
}
