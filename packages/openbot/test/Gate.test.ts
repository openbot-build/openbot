import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import { Config, Model, Provider } from "@openbot-build/core"
import { Authorization, Bots as BotDomain } from "@openbot-build/domain"
import { Array as Arr, Effect, Layer, Option, Ref, Schema } from "effect"
import { DecisionModel } from "effect/ai"
import { Bots } from "../src/bots/Bots.ts"
import { Grants } from "../src/capabilities/Grants.ts"
import { Requests } from "../src/capabilities/Requests.ts"
import { Rules } from "../src/capabilities/Rules.ts"
import { Store } from "../src/execution/Store.ts"
import { AnyModel, ModelRegistry } from "../src/models/ModelRegistry.ts"
import { Secrets } from "../src/secrets/Secrets.ts"
import { bot } from "./BotFixture.ts"
import * as Fixture from "./GateFixture.ts"

const boss: BotDomain.Bot = {
	...bot,
	id: BotDomain.BotId.make("bot_boss"),
	name: "Lead",
	role: "Leads other Bots",
}
const selection = Config.Selection.make({
	provider: Provider.Id.make("test"),
	model: Model.Id.make("rules"),
})

layer(Fixture.services, { excludeTestServices: true, timeout: "60 seconds" })(
	(it) => {
		it.effect(
			"a policy read failure denies the saved call and seals the full cause",
			() =>
				Effect.gen(function* () {
					const test = yield* Fixture.setup("gate-policy-down")
					const gate = yield* test.build().pipe(
						Effect.provide(
							Layer.mock(Authorization.Auth, {
								domain: Authorization.OpenBot,
								check: () =>
									Effect.fail(
										Authorization.PolicyUnavailable.make({
											cause: "The database is down.",
										}),
									),
							}),
						),
					)
					const answer = yield* gate.check(test.attempt)
					assert.equal(answer._tag, "Deny")
					if (answer._tag !== "Deny") return
					assert.isUndefined(answer.request)
					const requests = yield* Requests
					assert.isEmpty(
						yield* requests.forChat(
							Fixture.actor.organizationId,
							test.frame.chat,
						),
					)
					const sql = yield* PgClient.PgClient
					const rows = yield* sql<{
						id: string
						cause: string
					}>`select id, cause from openbot_execution_failures where execution_id = ${test.fence.id}`
					assert.lengthOf(rows, 1)
					const failure = rows[0]!
					assert.include(answer.reason, failure.id)
					assert.notInclude(answer.reason, "The database is down.")
					assert.notInclude(failure.cause, "The database is down.")
					const cause = yield* (yield* Secrets).open(
						failure.cause,
						`failure:${failure.id}`,
					)
					assert.include(cause, "PolicyUnavailable")
					assert.include(cause, "The database is down.")
					assert.notInclude(cause, "A private note.")
					assert.deepEqual(
						yield* gate.answer(test.call.id),
						Option.some(answer),
					)
				}),
		)

		it.effect("a once Grant taken by another call goes to a decider", () =>
			Effect.gen(function* () {
				const test = yield* Fixture.setup("gate-grant-race")
				const grants = yield* Grants
				const grant = yield* grants.create(Fixture.actor.organizationId, {
					bot: bot.id,
					capability: test.attempt.capability,
					effect: "allow",
					scope: "once",
					grantedBy: { _tag: "Person", userId: Fixture.actor.userId },
				})
				yield* Effect.addFinalizer(() =>
					grants
						.revoke(Fixture.actor.organizationId, bot.id, grant.id)
						.pipe(Effect.orDie),
				)
				const raced = yield* Ref.make(0)
				const gate = yield* test.build().pipe(
					Effect.provideService(Grants, {
						...grants,
						use: () =>
							Ref.update(raced, (count) => count + 1).pipe(Effect.as(false)),
					}),
				)
				const answer = yield* gate.check(test.attempt)
				assert.equal(answer._tag, "Pending")
				assert.equal(yield* Ref.get(raced), 1)
				assert.equal(
					Option.getOrThrow(
						yield* grants.find(Fixture.actor.organizationId, grant.id),
					).status,
					"active",
				)
				const saved = yield* (yield* Requests).forChat(
					Fixture.actor.organizationId,
					test.frame.chat,
				)
				assert.lengthOf(saved, 1)
				assert.deepEqual(saved[0]?.call?.params, test.call.params)
				assert.deepEqual(yield* gate.check(test.attempt), answer)
				assert.equal(yield* Ref.get(raced), 1)
			}),
		)

		it.effect("a new execution scope checks the call again", () =>
			Effect.gen(function* () {
				const test = yield* Fixture.setup("gate-fresh-scope")
				const first = yield* test.build()
				const denied = {
					_tag: "Deny" as const,
					reason: "The prior check failed.",
				}
				yield* first.remember(test.call.id, denied)
				assert.deepEqual(yield* first.answer(test.call.id), Option.some(denied))
				const next = yield* test.build(
					yield* (yield* Store).takeOver(test.fence),
				)
				assert.deepEqual(yield* next.answer(test.call.id), Option.none())
				assert.equal((yield* next.check(test.attempt))._tag, "Pending")
				assert.deepEqual(yield* first.answer(test.call.id), Option.some(denied))
			}),
		)

		it.effect(
			"a Rule from the Bot above uses that Bot and its held capability",
			() =>
				Effect.gen(function* () {
					const test = yield* Fixture.setup("gate-rule-owner", [boss.id])
					const rules = yield* Rules
					yield* rules.create(Fixture.actor.organizationId, {
						bot: bot.id,
						author: { _tag: "Bot", bot: boss.id },
						text: "The Bot may search.",
						status: "active",
					})
					yield* rules.create(Fixture.actor.organizationId, {
						bot: boss.id,
						author: { _tag: "Person", userId: Fixture.actor.userId },
						text: "The Bot may search.",
						status: "active",
					})
					const judged = yield* Ref.make<ReadonlyArray<string>>([])
					const model = yield* DecisionModel.make({
						decide: (options) =>
							Effect.gen(function* () {
								const input = yield* Schema.decodeUnknownEffect(
									Schema.Struct({
										bot: Schema.Struct({ name: Schema.String }),
									}),
								)(options.state).pipe(Effect.orDie)
								yield* Ref.update(judged, Arr.append(input.bot.name))
								return {
									answers: {
										decision: {
											_tag: "Classify" as const,
											label: "allow",
											probabilities: { allow: 1, deny: 0, no_match: 0 },
										},
										rule_0: { _tag: "Probability" as const, probability: 1 },
									},
									usage: { inputTokens: 10, outputTokens: 0 },
								}
							}),
					})
					const gate = yield* test.build().pipe(
						Effect.provide([
							Layer.mock(Bots, {
								find: (_, id) =>
									Effect.succeed(
										id === boss.id ? Option.some(boss) : Option.none(),
									),
							}),
							Layer.mock(ModelRegistry, {
								defaultModel: Option.none(),
								helperSelection: () => Effect.succeed(selection),
								resolveAny: () => Effect.succeed(AnyModel.Decision({ model })),
							}),
						]),
					)
					assert.equal((yield* gate.check(test.attempt))._tag, "Allow")
					assert.deepEqual(yield* Ref.get(judged), [bot.name, boss.name])
					assert.equal((yield* gate.check(test.attempt))._tag, "Allow")
					assert.deepEqual(yield* Ref.get(judged), [bot.name, boss.name])
					const calls = yield* (yield* Store).calls(test.fence)
					assert.lengthOf(calls, 2)
					assert.isTrue(Arr.every(calls, (call) => call.status === "completed"))
				}),
		)
	},
)
