// @effect-diagnostics strictEffectProvide:off
import { assert, it } from "@effect/vitest"
import { Config, Model, Provider } from "@openbot-build/core"
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

it.effect(
	"the default directory runs, rejects unknown choices and labels synthetic usage",
	() =>
		Effect.gen(function* () {
			const { builtinModels: models } = yield* DevelopmentModel.make
			assert.deepStrictEqual<ReadonlyArray<string>>(
				[...models.models.map((model) => model.id)].sort(),
				[...DevelopmentModel.Scenario.literals].sort(),
			)
			assert.ok(
				models.models.every((model) => model.name.includes("simulated")),
			)
			// The first model is the default of a new Chat.
			assert.strictEqual(models.models[0]?.id, DevelopmentModel.selection.model)
			const model = yield* models.resolve(DevelopmentModel.selection)
			const response = yield* model.generateText({ prompt: "Hello" })
			assert.strictEqual(response.text, "Development response: Hello")
			assert.strictEqual(response.finishReason, "stop")
			assert.strictEqual(response.usage.inputTokens.total, 10)
			assert.deepStrictEqual(
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
				(selection) => models.resolve(selection).pipe(Effect.flip),
			)
			assert.deepStrictEqual(
				errors.map((error) => error.reason),
				[
					"provider-not-found",
					"model-not-found",
					"unsupported-option",
					"unsupported-option",
				],
			)
		}),
)

// it.effect gives a TestClock, so the time does not move forward.
it.effect(
	"normal and streaming text match without moving the clock forward",
	() =>
		Effect.gen(function* () {
			const normal = yield* LanguageModel.generateText({
				prompt: "No decorative delay",
			})
			const parts = yield* Stream.runCollect(
				LanguageModel.streamText({ prompt: "No decorative delay" }),
			)
			assert.strictEqual(
				parts
					.filter((part) => part.type === "text-delta")
					.map((part) => part.delta)
					.join(""),
				normal.text,
			)
			assert.strictEqual(
				parts.find((part) => part.type === "finish")?.reason,
				normal.finishReason,
			)
		}).pipe(Effect.provide(DevelopmentModel.layer("mock-text"))),
	2000,
)

it.effect(
	"every scenario refuses structured requests, so it never makes up data",
	() =>
		Effect.forEach(DevelopmentModel.Scenario.literals, (scenario) =>
			Effect.gen(function* () {
				for (const [objectName, schema] of [
					["unknown", Schema.Struct({})],
					[
						"memory_changes",
						Schema.Struct({ changes: Schema.Array(Schema.String) }),
					],
					["answer", Schema.Struct({ required: Schema.String })],
				] as const) {
					const error = yield* LanguageModel.generateObject({
						objectName,
						schema,
						prompt: "Give a structured answer",
					}).pipe(Effect.flip)
					assert.strictEqual(error.reason._tag, "InvalidRequestError", scenario)
				}
			}).pipe(Effect.provide(DevelopmentModel.layer(scenario))),
		),
)

it.effect(
	"tool continuation waits for real approval, runs once and shows the real results",
	() => {
		let executions = 0
		const handlers = DevelopmentModel.toolkit.toLayer({
			DevelopmentConfirmation: ({ description }) =>
				Effect.sync(() => {
					executions += 1
					return { confirmed: `Handler result: ${description}` }
				}),
		})
		return Effect.gen(function* () {
			const firstPrompt = Prompt.make("Check the approval")
			const first = yield* LanguageModel.generateText({
				prompt: firstPrompt,
				toolkit: DevelopmentModel.toolkit,
			})
			assert.strictEqual(executions, 0)
			assert.strictEqual(first.finishReason, "tool-calls")
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
			assert.strictEqual(executions, 0)
			assert.match(denied.text, /rejected.*execution-denied/)
			const approvedPrompt = decide(true)
			const approved = yield* LanguageModel.generateText({
				prompt: approvedPrompt,
				toolkit: DevelopmentModel.toolkit,
			})
			assert.strictEqual(executions, 1)
			assert.strictEqual(
				approved.text,
				"Development confirmation result: Handler result: Check the approval",
			)
			const continued = Prompt.concat(
				approvedPrompt,
				Prompt.fromResponseParts(approved.content),
			)
			assert.strictEqual(
				(yield* LanguageModel.generateText({
					prompt: continued,
					toolkit: DevelopmentModel.toolkit,
				})).text,
				approved.text,
			)
			assert.strictEqual(executions, 1)
			const next = yield* LanguageModel.generateText({
				prompt: "Another independent turn",
				toolkit: DevelopmentModel.toolkit,
			})
			assert.strictEqual(next.toolCalls.length, 1)
			assert.strictEqual(executions, 1)
		}).pipe(
			Effect.provide(
				Layer.merge(DevelopmentModel.layer("mock-tool"), handlers),
			),
		)
	},
)

it.effect(
	"slow streaming can be interrupted and stops sending output after cancellation",
	() =>
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
			assert.deepStrictEqual(yield* Ref.get(output), ["Development "])
			yield* Fiber.interrupt(fiber)
			const exit = yield* Fiber.await(fiber)
			assert.ok(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))
			yield* TestClock.adjust("20 seconds")
			assert.deepStrictEqual(yield* Ref.get(output), ["Development "])
		}).pipe(Effect.provide(DevelopmentModel.layer("mock-slow"))),
	5000,
)

it.effect(
	"failure is typed, and streaming sends partial output before it fails",
	() =>
		Effect.gen(function* () {
			const failure = yield* LanguageModel.generateText({
				prompt: "Fail",
			}).pipe(Effect.flip)
			assert.strictEqual(failure.reason._tag, "InvalidOutputError")
			const seen = yield* Ref.make<ReadonlyArray<string>>([])
			const streamed = yield* LanguageModel.streamText({ prompt: "Fail" }).pipe(
				Stream.filter((part) => part.type === "text-delta"),
				Stream.runForEach((part) =>
					Ref.update(seen, (parts) => EffectArray.append(parts, part.delta)),
				),
				Effect.flip,
			)
			assert.strictEqual(streamed.reason._tag, "InvalidOutputError")
			assert.deepStrictEqual(yield* Ref.get(seen), [
				"Development failure: partial output.",
			])
		}).pipe(Effect.provide(DevelopmentModel.layer("mock-failure"))),
)
