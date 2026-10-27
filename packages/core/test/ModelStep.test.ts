import { assert, it } from "@effect/vitest"
import { Array as Arr, Effect, Ref, Schema, Stream } from "effect"
import { Prompt, Response, Tool, Toolkit } from "effect/ai"
import * as ModelStep from "../src/chat/ModelStep.ts"
import {
	LanguageModelTest,
	finish,
	textParts,
	usage,
} from "./LanguageModelTest.ts"

const Write = Tool.make("Write", {
	parameters: Schema.Struct({ text: Schema.String }),
	success: Schema.String,
})
const toolkit = Toolkit.make(Write)
for (const ended of [true, false]) {
	it.effect(
		`provider error parts keep their cause with finish set to ${ended}`,
		() =>
			Effect.gen(function* () {
				const result = yield* ModelStep.run(
					{ prompt: Prompt.make("Write a note"), toolkit },
					() => Effect.void,
				).pipe(Effect.flip)
				assert.isTrue(Schema.is(ModelStep.Failed)(result))
				if (!Schema.is(ModelStep.Failed)(result)) return
				assert.deepStrictEqual(result.errors, [
					{ code: "failed", message: "The provider failed." },
				])
				assert.deepStrictEqual(result.usage, ended ? usage : null)
			}).pipe(
				Effect.provide(
					LanguageModelTest({
						streamText: () =>
							Stream.fromArray([
								Response.makePart("tool-call", {
									id: "call-1",
									name: "Write",
									params: { text: "A note" },
									providerExecuted: false,
								}),
								Response.makePart("error", {
									error: { code: "failed", message: "The provider failed." },
								}),
								...(ended ? [finish("error")] : []),
							]),
					}),
				),
			),
	)
}
it.effect(
	"a model step returns calls without loading or running tool handlers",
	() =>
		Effect.gen(function* () {
			const parts = yield* Ref.make(0)
			const result = yield* ModelStep.run(
				{ prompt: Prompt.make("Write a note"), toolkit },
				() => Ref.update(parts, (n) => n + 1),
			)
			assert.deepStrictEqual(result.calls, [
				{ id: "call-1", name: "Write", params: { text: "A note" } },
			])
			assert.strictEqual(result.finishReason, "tool-calls")
			assert.strictEqual(yield* Ref.get(parts), 2)
		}).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () =>
						Stream.make(
							Response.makePart("tool-call", {
								id: "call-1",
								name: "Write",
								params: { text: "A note" },
								providerExecuted: false,
							}),
							finish("tool-calls"),
						),
				}),
			),
		),
)
it.effect(
	"a model stream without a finish part cannot become a saved step",
	() =>
		Effect.gen(function* () {
			const result = yield* ModelStep.run(
				{ prompt: Prompt.make("Write a note"), toolkit },
				() => Effect.void,
			).pipe(Effect.flip)
			assert.strictEqual(result._tag, "ModelStepIncomplete")
		}).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () =>
						Stream.fromArray(
							Arr.filter(
								textParts("partial"),
								(part) => part.type !== "finish",
							),
						),
				}),
			),
		),
)

for (const approved of [true, false]) {
	it.effect(
		`a model step cannot resolve a call with approval set to ${approved}`,
		() =>
			Effect.gen(function* () {
				const prompt = Prompt.make([
					{
						role: "assistant",
						content: [
							Prompt.toolCallPart({
								id: "call-1",
								name: "Write",
								params: { text: "A note" },
								providerExecuted: false,
							}),
							Prompt.toolApprovalRequestPart({
								approvalId: "approval-1",
								toolCallId: "call-1",
							}),
						],
					},
					{
						role: "tool",
						content: [
							Prompt.toolApprovalResponsePart({
								approvalId: "approval-1",
								approved,
							}),
						],
					},
				])
				const result = yield* ModelStep.run(
					{ prompt, toolkit },
					() => Effect.void,
				).pipe(Effect.flip)
				assert.strictEqual(result._tag, "ModelStepUnresolvedCalls")
				if (result._tag === "ModelStepUnresolvedCalls")
					assert.deepStrictEqual(result.calls, ["call-1"])
			}).pipe(
				Effect.provide(
					LanguageModelTest({
						streamText: () =>
							Stream.die(
								"The model must not run before tool results are saved",
							),
					}),
				),
			),
	)
}
it.effect(
	"a saved tool result permits the next model step without a tool handler",
	() =>
		Effect.gen(function* () {
			const prompt = Prompt.make([
				{
					role: "assistant",
					content: [
						Prompt.toolCallPart({
							id: "call-1",
							name: "Write",
							params: { text: "A note" },
							providerExecuted: false,
						}),
						Prompt.toolApprovalRequestPart({
							approvalId: "approval-1",
							toolCallId: "call-1",
						}),
					],
				},
				{
					role: "tool",
					content: [
						Prompt.toolApprovalResponsePart({
							approvalId: "approval-1",
							approved: true,
						}),
						Prompt.toolResultPart({
							id: "call-1",
							name: "Write",
							result: "Saved",
							isFailure: false,
							providerExecuted: false,
						}),
					],
				},
			])
			const result = yield* ModelStep.run(
				{ prompt, toolkit },
				() => Effect.void,
			)
			assert.strictEqual(result.finishReason, "stop")
			assert.deepStrictEqual(result.calls, [])
		}).pipe(
			Effect.provide(
				LanguageModelTest({
					streamText: () => Stream.fromArray(textParts("Saved")),
				}),
			),
		),
)
