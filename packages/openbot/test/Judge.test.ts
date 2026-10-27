import { NodeCrypto } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { BotsApi } from "@openbot-build/api"
import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Record as Rec,
	Ref,
	Schema,
} from "effect"
import { DecisionModel } from "effect/ai"
import { TestClock } from "effect/testing"
import { BotRecords } from "../src/bots/BotRecords.ts"
import * as Judge from "../src/capabilities/Judge.ts"
import { AnyModel } from "../src/models/ModelRegistry.ts"
import { Records } from "../src/errors/Records.ts"
import { bot } from "./BotFixture.ts"

const rule = (id: string, text: string): BotsApi.Rule => ({
	id: BotsApi.RuleId.make(id),
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
const noRecords = Layer.mock(BotRecords, {
	collection: () => ({
		find: () => Effect.succeedNone,
		list: () => Effect.succeed([]),
		put: () => Effect.void,
		remove: () => Effect.void,
	}),
})
const noFailures = Layer.mock(Records, {
	record: () => Effect.die("No failure record was expected."),
})

/** A judge with a decision model that gives fixed answers. It keeps every request. */
const judgeWith = Effect.fn("Judge.judgeWith")(function* (answers: {
	readonly decision: "allow" | "deny" | "no_match"
	readonly likelihoods: ReadonlyArray<number>
}) {
	const sent = yield* Ref.make<ReadonlyArray<DecisionModel.ProviderOptions>>([])
	const layer = Layer.effect(Judge.Judge, Judge.make).pipe(
		Layer.provide([
			noRecords,
			noFailures,
			NodeCrypto.layer,
			Layer.effect(
				Judge.HelperModel,
				Effect.map(
					DecisionModel.make({
						decide: (options) =>
							Ref.update(sent, Arr.append(options)).pipe(
								Effect.as({
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
										...Rec.fromEntries(
											Arr.map(
												answers.likelihoods,
												(probability, index) =>
													[
														`rule_${index}`,
														{ _tag: "Probability", probability },
													] as const,
											),
										),
									},
									usage: { inputTokens: 10, outputTokens: 0 },
								}),
							),
					}),
					(model) => ({
						rules: () => Effect.succeed(AnyModel.Decision({ model })),
						botMemory: () => Effect.die("unused"),
					}),
				),
			),
		]),
	)
	return { sent: Ref.get(sent), layer }
})

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
			const judge = yield* judgeWith({
				decision: "allow",
				likelihoods: [0.9, 0.1],
			})
			const verdict = yield* decide.pipe(Effect.provide(judge.layer))
			assert.strictEqual(verdict.decision, "allow")
			assert.deepStrictEqual(verdict.citations, [
				{
					rule: BotsApi.RuleId.make("rule_read"),
					quote: "The Bot may call read_docs.",
				},
			])
			// The model gets the request and the Rules, and one question for each Rule.
			const first = Arr.head(yield* judge.sent)
			assert.ok(Option.isSome(first))
			assert.deepStrictEqual(Rec.keys(first.value.decisions), [
				"decision",
				"rule_0",
				"rule_1",
			])
			const { request } = yield* Schema.decodeUnknownEffect(
				Schema.Struct({ request: Schema.Unknown }),
			)(first.value.state)
			assert.deepStrictEqual(request, {
				capability: { action: "tools.call", target: "read_docs" },
				reason: "To answer a question.",
			})
		}),
)

it.effect("a decision without a likely Rule, or no_match, gives no_match", () =>
	Effect.gen(function* () {
		for (const answers of [
			{ decision: "deny", likelihoods: [0.2, 0.3] },
			{ decision: "no_match", likelihoods: [0.9, 0.9] },
		] as const) {
			const judge = yield* judgeWith(answers)
			const verdict = yield* decide.pipe(Effect.provide(judge.layer))
			assert.strictEqual(verdict.decision, "no_match")
			assert.deepStrictEqual(verdict.citations, [])
		}
	}),
)

/** A judge with a decision model that answers with the given effect. */
const judgeAnswering = (answer: Effect.Effect<never>) =>
	Layer.effect(Judge.Judge, Judge.make).pipe(
		Layer.provide([
			noRecords,
			noFailures,
			NodeCrypto.layer,
			Layer.effect(
				Judge.HelperModel,
				Effect.map(DecisionModel.make({ decide: () => answer }), (model) => ({
					rules: () => Effect.succeed(AnyModel.Decision({ model })),
					botMemory: () => Effect.die("unused"),
				})),
			),
		]),
	)

it.effect(
	"an interruption inside the judge is not a model failure, so it gives no verdict",
	() =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				decide.pipe(Effect.provide(judgeAnswering(Effect.interrupt))),
			)
			assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
		}),
)

it.effect("a judge that does not answer in time gives no_match", () =>
	Effect.gen(function* () {
		const fiber = yield* decide.pipe(
			Effect.provide(judgeAnswering(Effect.never)),
			Effect.forkChild({ startImmediately: true }),
		)
		yield* TestClock.adjust("15 seconds")
		const verdict = yield* Fiber.join(fiber)
		assert.deepStrictEqual(verdict, {
			decision: "no_match",
			citations: [],
			explanation: "The judge did not answer in time.",
		})
	}),
)
