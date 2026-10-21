// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import { Config, Item, Model, Provider } from "@openbot-build/core"
import * as LanguageModelMemory from "../src/plugins/memory/LanguageModelMemory.ts"
import * as Memory from "../src/plugins/memory/Memory.ts"
import {
	Array as EffectArray,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Ref,
	Schema,
	Stream,
} from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import { TestClock } from "effect/testing"
import * as DevelopmentModel from "../src/app/DevelopmentModel.ts"

const evidence = {
	state: Memory.empty(),
	history: [
		{
			id: Item.Id.make("evidence"),
			content: Prompt.make("A one-time instruction"),
		},
	],
}
test("the default directory runs, rejects unknown choices and labels synthetic usage", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const options = yield* DevelopmentModel.make
				const catalog = yield* options.modelCatalog
				assert.deepEqual(
					catalog.models.map((model) => model.id),
					DevelopmentModel.Scenario.literals,
				)
				assert.ok(
					catalog.models.every((model) => model.name.includes("simulated")),
				)
				assert.deepEqual(yield* options.defaults, {
					model: DevelopmentModel.selection,
				})
				const model = yield* options.resolveModel(undefined)
				const response = yield* model.generateText({ prompt: "Hello" })
				assert.equal(response.text, "Development response: Hello")
				assert.equal(response.finishReason, "stop")
				assert.equal(response.usage.inputTokens.total, 10)
				assert.deepEqual(
					response.content.find((part) => part.type === "finish")?.metadata,
					{
						development: { scenario: "mock-text", syntheticUsage: true },
					},
				)
				const errors = yield* Effect.forEach(
					[
						Config.Selection.make({
							provider: Provider.Id.make("unknown"),
							model: Model.Id.make("mock-text"),
						}),
						Config.Selection.make({
							provider: DevelopmentModel.provider,
							model: Model.Id.make("unknown"),
						}),
						Config.Selection.make({
							...DevelopmentModel.selection,
							reasoningEffort: "high",
						}),
						Config.Selection.make({
							...DevelopmentModel.selection,
							serviceTier: "priority",
						}),
					],
					(selection) => options.resolveModel(selection).pipe(Effect.flip),
				)
				assert.deepEqual(
					errors.map((error) => error.reason),
					[
						"provider-not-found",
						"model-not-found",
						"unsupported-option",
						"unsupported-option",
					],
				)
			}),
		),
	)
})

test(
	"normal and streaming text match without moving the clock forward",
	{ timeout: 2000 },
	async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const normal = yield* LanguageModel.generateText({
					prompt: "No decorative delay",
				})
				const parts = yield* Stream.runCollect(
					LanguageModel.streamText({ prompt: "No decorative delay" }),
				)
				assert.equal(
					parts
						.filter((part) => part.type === "text-delta")
						.map((part) => part.delta)
						.join(""),
					normal.text,
				)
				assert.equal(
					parts.find((part) => part.type === "finish")?.reason,
					normal.finishReason,
				)
			}).pipe(
				Effect.provide(
					Layer.merge(DevelopmentModel.layer("mock-text"), TestClock.layer()),
				),
			),
		)
	},
)

test("all scenarios check consolidation evidence and return no made-up Memory", async () => {
	await Effect.runPromise(
		Effect.forEach(DevelopmentModel.Scenario.literals, (scenario) =>
			Effect.gen(function* () {
				assert.deepEqual(yield* LanguageModelMemory.model.extract(evidence), {
					changes: [],
				})
			}).pipe(Effect.provide(DevelopmentModel.layer(scenario))),
		),
	)
})

test("structured input and output checks reject malformed or unsupported requests", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const unknown = yield* LanguageModel.generateObject({
				objectName: "unknown",
				schema: Memory.Extraction,
				prompt: JSON.stringify(evidence),
			}).pipe(Effect.flip)
			assert.equal(unknown.reason._tag, "InvalidRequestError")
			const malformed = yield* LanguageModel.generateObject({
				objectName: "memory_changes",
				schema: Memory.Extraction,
				prompt: "{}",
			}).pipe(Effect.flip)
			assert.equal(malformed.reason._tag, "InvalidRequestError")
			const invalidOutput = yield* LanguageModel.generateObject({
				objectName: "memory_changes",
				schema: Schema.Struct({ required: Schema.String }),
				prompt: JSON.stringify(evidence),
			}).pipe(Effect.flip)
			assert.equal(invalidOutput.reason._tag, "StructuredOutputError")
		}).pipe(Effect.provide(DevelopmentModel.layer("mock-text"))),
	)
})

test("tool continuation waits for real approval, runs once and shows the real results", async () => {
	let executions = 0
	const handlers = DevelopmentModel.toolkit.toLayer({
		DevelopmentConfirmation: ({ description }) =>
			Effect.sync(() => {
				executions += 1
				return { confirmed: `Handler result: ${description}` }
			}),
	})
	await Effect.runPromise(
		Effect.gen(function* () {
			const firstPrompt = Prompt.make("Check the approval")
			const first = yield* LanguageModel.generateText({
				prompt: firstPrompt,
				toolkit: DevelopmentModel.toolkit,
			})
			assert.equal(executions, 0)
			assert.equal(first.finishReason, "tool-calls")
			const approval = first.content.find(
				(part) => part.type === "tool-approval-request",
			)
			assert.ok(approval)
			const pending = Prompt.concat(
				firstPrompt,
				Prompt.fromResponseParts(first.content),
			)
			const decide = (approved: boolean) =>
				Prompt.concat(
					pending,
					Prompt.make([
						{
							role: "tool",
							content: [
								{
									type: "tool-approval-response",
									approvalId: approval.approvalId,
									approved,
								},
							],
						},
					]),
				)
			const denied = yield* LanguageModel.generateText({
				prompt: decide(false),
				toolkit: DevelopmentModel.toolkit,
			})
			assert.equal(executions, 0)
			assert.match(denied.text, /rejected.*execution-denied/)
			const approvedPrompt = decide(true)
			const approved = yield* LanguageModel.generateText({
				prompt: approvedPrompt,
				toolkit: DevelopmentModel.toolkit,
			})
			assert.equal(executions, 1)
			assert.equal(
				approved.text,
				"Development confirmation result: Handler result: Check the approval",
			)
			const continued = Prompt.concat(
				approvedPrompt,
				Prompt.fromResponseParts(approved.content),
			)
			assert.equal(
				(yield* LanguageModel.generateText({
					prompt: continued,
					toolkit: DevelopmentModel.toolkit,
				})).text,
				approved.text,
			)
			assert.equal(executions, 1)
			assert.deepEqual(yield* LanguageModelMemory.model.extract(evidence), {
				changes: [],
			})
			const next = yield* LanguageModel.generateText({
				prompt: "Another independent turn",
				toolkit: DevelopmentModel.toolkit,
			})
			assert.equal(next.toolCalls.length, 1)
			assert.equal(executions, 1)
		}).pipe(
			Effect.provide(
				Layer.merge(DevelopmentModel.layer("mock-tool"), handlers),
			),
		),
	)
})

test(
	"slow streaming can be interrupted and stops sending output after cancellation",
	{ timeout: 5000 },
	async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const output = yield* Ref.make<ReadonlyArray<string>>([])
				const started = yield* Deferred.make<void>()
				const fiber = yield* LanguageModel.streamText({
					prompt: "Cancel this response",
				}).pipe(
					Stream.filter((part) => part.type === "text-delta"),
					Stream.runForEach((part) =>
						Ref.update(output, (parts) =>
							EffectArray.append(parts, part.delta),
						).pipe(Effect.andThen(Deferred.succeed(started, undefined))),
					),
					Effect.forkChild,
				)
				yield* Deferred.await(started)
				assert.deepEqual(yield* Ref.get(output), ["Development "])
				yield* Fiber.interrupt(fiber)
				const exit = yield* Fiber.await(fiber)
				assert.ok(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))
				yield* TestClock.adjust("20 seconds")
				assert.deepEqual(yield* Ref.get(output), ["Development "])
			}).pipe(
				Effect.provide(
					Layer.merge(DevelopmentModel.layer("mock-slow"), TestClock.layer()),
				),
			),
		)
	},
)

test("failure is typed, and streaming sends partial output before it fails", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const failure = yield* LanguageModel.generateText({
				prompt: "Fail",
			}).pipe(Effect.flip)
			assert.equal(failure.reason._tag, "InvalidOutputError")
			const seen = yield* Ref.make<ReadonlyArray<string>>([])
			const streamed = yield* LanguageModel.streamText({ prompt: "Fail" }).pipe(
				Stream.filter((part) => part.type === "text-delta"),
				Stream.runForEach((part) =>
					Ref.update(seen, (parts) => EffectArray.append(parts, part.delta)),
				),
				Effect.flip,
			)
			assert.equal(streamed.reason._tag, "InvalidOutputError")
			assert.deepEqual(yield* Ref.get(seen), [
				"Development failure: partial output.",
			])
		}).pipe(Effect.provide(DevelopmentModel.layer("mock-failure"))),
	)
})
