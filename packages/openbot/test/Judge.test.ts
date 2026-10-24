// Each test owns the Layers that it provides at the point where it runs.
// @effect-diagnostics strictEffectProvide:off

import { assert, it } from "@effect/vitest"
import type { BotsApi } from "@openbot-build/api"
import { Effect, Layer } from "effect"
import { DecisionModel } from "effect/ai"
import { BotRecords } from "../src/bots/BotRecords.ts"
import * as Judge from "../src/capabilities/Judge.ts"
import { AnyModel } from "../src/models/ModelRegistry.ts"
import { bot } from "./BotFixture.ts"

const rule = (id: string, text: string): BotsApi.Rule => ({
	id,
	bot: bot.id,
	author: { _tag: "Person", userId: "alice" },
	text,
	status: "active",
	version: 1,
	createdAt: 0,
	updatedAt: 0,
})

const rules = [
	rule("rule_read", "The Bot may call read_docs."),
	rule("rule_mail", "The Bot must never call send_mail."),
]

/** Bot records that keep nothing, so the judge asks the model each time. */
const noRecords = Layer.succeed(BotRecords, {
	collection: () => ({
		find: () => Effect.succeedNone,
		list: () => Effect.succeed([]),
		withStatus: () => Effect.succeed([]),
		put: () => Effect.void,
		remove: () => Effect.void,
	}),
	transaction: () => Effect.die("unused"),
} as unknown as BotRecords["Service"])

/** A judge with a decision model that gives fixed answers. */
const judgeWith = (answers: {
	readonly decision: "allow" | "deny" | "no_match"
	readonly likelihoods: ReadonlyArray<number>
}) => {
	const sent: Array<DecisionModel.ProviderOptions> = []
	const layer = Layer.effect(Judge.Judge, Judge.make).pipe(
		Layer.provide([
			noRecords,
			Layer.effect(
				Judge.HelperModel,
				Effect.map(
					DecisionModel.make({
						decide: (options) => {
							sent.push(options)
							return Effect.succeed({
								answers: {
									decision: {
										_tag: "Classify",
										label: answers.decision,
										probabilities: {
											allow: answers.decision === "allow" ? 1 : 0,
											deny: answers.decision === "deny" ? 1 : 0,
											no_match: answers.decision === "no_match" ? 1 : 0,
										},
									},
									...Object.fromEntries(
										answers.likelihoods.map((probability, index) => [
											`rule_${index}`,
											{ _tag: "Probability", probability },
										]),
									),
								},
								usage: { inputTokens: 10, outputTokens: 0 },
							})
						},
					}),
					(model) => ({
						rules: () => Effect.succeed(AnyModel.Decision({ model })),
						botMemory: () => Effect.die("unused"),
					}),
				),
			),
		]),
	)
	return { sent, layer }
}

const decide = Effect.flatMap(Judge.Judge, (judge) =>
	judge.decide({
		organizationId: "org_a",
		bot,
		capability: { action: "tools.call", target: "read_docs" },
		reason: "To answer a question.",
		rules,
	}),
)

it.effect(
	"a decision model judges Rules, and the verdict quotes each likely Rule",
	() =>
		Effect.gen(function* () {
			const judge = judgeWith({ decision: "allow", likelihoods: [0.9, 0.1] })
			const verdict = yield* decide.pipe(Effect.provide(judge.layer))
			assert.strictEqual(verdict.decision, "allow")
			assert.deepStrictEqual(verdict.citations, [
				{
					rule: "rule_read",
					quote: "The Bot may call read_docs.",
				},
			])
			// The model gets the request and the Rules, and one question for each Rule.
			assert.deepStrictEqual(Object.keys(judge.sent[0]?.decisions ?? {}), [
				"decision",
				"rule_0",
				"rule_1",
			])
			assert.deepStrictEqual(
				(judge.sent[0]?.state as { request: unknown }).request,
				{
					capability: { action: "tools.call", target: "read_docs" },
					reason: "To answer a question.",
				},
			)
		}),
)

it.effect("a decision without a likely Rule, or no_match, gives no_match", () =>
	Effect.gen(function* () {
		for (const answers of [
			{ decision: "deny", likelihoods: [0.2, 0.3] },
			{ decision: "no_match", likelihoods: [0.9, 0.9] },
		] as const) {
			const verdict = yield* decide.pipe(
				Effect.provide(judgeWith(answers).layer),
			)
			assert.strictEqual(verdict.decision, "no_match")
			assert.deepStrictEqual(verdict.citations, [])
		}
	}),
)
