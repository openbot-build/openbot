import { assert, describe, it } from "@effect/vitest"
import { Authorization, BotsApi } from "@openbot-build/api"
import { Chat, Turn } from "@openbot-build/core"
import {
	Array as Arr,
	Cause,
	Effect,
	HashMap,
	Layer,
	Logger,
	Option,
	Ref,
	References,
	Schema,
} from "effect"
import { Bots } from "../src/bots/Bots.ts"
import * as Signals from "../src/bots/Signals.ts"
import * as Gate from "../src/capabilities/Gate.ts"
import { Grants } from "../src/capabilities/Grants.ts"
import { Judge } from "../src/capabilities/Judge.ts"
import { Requests, type Stored } from "../src/capabilities/Requests.ts"
import { Rules } from "../src/capabilities/Rules.ts"
import { Work } from "../src/capabilities/Work.ts"
import { bot } from "./BotFixture.ts"

interface Line {
	readonly level: string
	readonly message: unknown
	readonly cause: Cause.Cause<unknown>
	readonly annotations: Readonly<Record<string, unknown>>
}

/** Keeps every log line of a test in place of the normal output. */
const collect = () => {
	let lines: ReadonlyArray<Line> = []
	const layer = Logger.layer([
		Logger.make((log) => {
			lines = [
				...lines,
				{
					level: log.logLevel,
					message: log.message,
					cause: log.cause,
					annotations: log.fiber.getRef(References.CurrentLogAnnotations),
				},
			]
		}),
	])
	return { layer, lines: () => lines }
}

/**
 * A Gate with fakes. Each fake has only the methods that the check of a test may call.
 * A method that a test does not give stops the test with an "unimplemented" defect.
 */
const gateWith = (fakes: {
	readonly auth: Omit<
		Layer.PartialEffectful<Authorization.Auth["Service"]>,
		"domain"
	>
	readonly requests?: Layer.PartialEffectful<Requests["Service"]>
	readonly grants?: Layer.PartialEffectful<Grants["Service"]>
	readonly rules?: Layer.PartialEffectful<Rules["Service"]>
	readonly judge?: Layer.PartialEffectful<Judge["Service"]>
	readonly bots?: Layer.PartialEffectful<Bots["Service"]>
}) =>
	Gate.layer.pipe(
		Layer.provide([
			Layer.mock(Authorization.Auth, {
				domain: Authorization.OpenBot,
				...fakes.auth,
			}),
			Layer.mock(Requests, fakes.requests ?? {}),
			Layer.mock(Grants, fakes.grants ?? {}),
			Layer.mock(Rules, fakes.rules ?? {}),
			Layer.mock(Judge, fakes.judge ?? {}),
			Layer.mock(Bots, fakes.bots ?? {}),
			Signals.layer,
		]),
	)

/** A policy that lets the member do everything. */
const allowAll = { check: () => Effect.void }

/** The Bot above the test Bot. It wrote a Rule for the test Bot. */
const boss: BotsApi.Bot = {
	...bot,
	id: BotsApi.BotId.make("bot_boss"),
	name: "Lead",
	role: "Leads the work of other Bots",
}

/** The Work of the test Bot in a Chat of its member. `boss` is above it. */
const work = Effect.map(
	Ref.make(HashMap.empty<string, Gate.Answer>()),
	(checks) =>
		Work.of({
			caller: {
				kind: "member",
				organizationId: "org_1",
				userId: "user_1",
			},
			namespace: "org_1:user_1",
			bot,
			chain: {
				organizationId: "org_1",
				userId: "user_1",
				bots: [boss.id, bot.id],
				chats: [Chat.Id.make("chat_boss")],
			},
			deciders: [boss.id, bot.id],
			chat: Chat.Id.make("chat_1"),
			turn: Turn.Id.make("turn_1"),
			checks,
		}),
)

const search = (gate: Gate.Gate["Service"]) =>
	Effect.flatMap(work, (current) =>
		gate
			.check({
				capability: { action: "tools.call", target: "search" },
				reason: "The Bot wants to search.",
				toolCallId: "call_1",
			})
			.pipe(Effect.provideService(Work, current)),
	)

const rule = (
	id: string,
	owner: BotsApi.Bot,
	author: BotsApi.Decider,
): BotsApi.Rule => ({
	id: BotsApi.RuleId.make(id),
	bot: owner.id,
	author,
	text: "The Bot may search.",
	status: "active",
	version: 1,
	createdAt: 0,
	updatedAt: 0,
})

describe("The capability check", () => {
	it.effect(
		"a policy that cannot be read gives Deny without a request, and a log with the cause",
		() => {
			const logs = collect()
			return Effect.gen(function* () {
				const created = yield* Ref.make(0)
				const gate = yield* Gate.Gate.pipe(
					Effect.provide(
						gateWith({
							auth: {
								check: () =>
									Effect.fail(
										Authorization.PolicyUnavailable.make({
											cause: "The database is down.",
										}),
									),
							},
							requests: {
								create: () =>
									Ref.update(created, (count) => count + 1).pipe(
										Effect.andThen(Effect.die("No request may be made.")),
									),
							},
						}),
					),
				)
				const answer = yield* search(gate)
				assert.deepStrictEqual(
					answer,
					Gate.Answer.Deny({
						reason: "OpenBot could not check this now. Try again later.",
					}),
				)
				// A failure to read the policy is not a "no" of the policy, so no denied request is kept.
				assert.strictEqual(yield* Ref.get(created), 0)
				const lines = logs.lines()
				assert.deepStrictEqual(
					Arr.map(lines, (line) => [line.level, line.message]),
					[["Warn", ["A capability check failed, so the call does not run"]]],
				)
				const [line] = lines
				assert.ok(line !== undefined)
				assert.ok(
					Schema.is(Authorization.PolicyUnavailable)(
						Option.getOrUndefined(Cause.findErrorOption(line.cause)),
					),
				)
				// The log names the call that it stopped, but not the arguments of the call.
				assert.deepStrictEqual(line.annotations, {
					toolCallId: "call_1",
					action: "tools.call",
					target: "search",
				})
			}).pipe(Effect.provide(logs.layer))
		},
	)

	it.effect(
		"a once Grant that another call took first does not allow the call, so it goes to a decider",
		() =>
			Effect.gen(function* () {
				const gate = yield* Gate.Gate.pipe(
					Effect.provide(
						gateWith({
							auth: allowAll,
							grants: {
								match: () =>
									Effect.succeedSome<BotsApi.Grant>({
										id: BotsApi.GrantId.make("grt_once"),
										bot: bot.id,
										capability: { action: "tools.call", target: "search" },
										effect: "allow",
										scope: "once",
										grantedBy: { _tag: "Person", userId: "user_1" },
										status: "active",
										createdAt: 0,
									}),
								use: () => Effect.succeed(false),
							},
							rules: { list: () => Effect.succeed([]) },
							judge: {
								decide: () =>
									Effect.succeed({
										decision: "no_match" as const,
										citations: [],
										explanation: "No Rule applies.",
									}),
							},
							requests: {
								create: () =>
									Effect.succeed({
										request: { id: "req_1", status: "pending" },
									} as unknown as Stored),
							},
						}),
					),
				)
				assert.deepStrictEqual(
					yield* search(gate),
					Gate.Answer.Pending({ request: "req_1" }),
				)
			}),
	)

	it.effect(
		"a Rule from the Bot above counts when that Bot holds the capability, and the judge sees that Bot",
		() =>
			Effect.gen(function* () {
				const judged = yield* Ref.make<ReadonlyArray<string>>([])
				const gate = yield* Gate.Gate.pipe(
					Effect.provide(
						gateWith({
							auth: allowAll,
							grants: { match: () => Effect.succeedNone },
							rules: {
								list: (_, owner) =>
									Effect.succeed(
										owner === bot.id
											? [rule("rule_bot", bot, { _tag: "Bot", bot: boss.id })]
											: [
													rule("rule_person", boss, {
														_tag: "Person",
														userId: "user_1",
													}),
												],
									),
							},
							judge: {
								decide: (input) =>
									Ref.update(judged, Arr.append(input.bot.name)).pipe(
										Effect.as({
											decision: "allow" as const,
											citations: Arr.map(input.rules, (cited) => ({
												rule: cited.id,
												quote: cited.text,
											})),
											explanation: "A Rule allows this.",
										}),
									),
							},
							bots: {
								find: (_, id) =>
									Effect.succeed(
										id === boss.id ? Option.some(boss) : Option.none(),
									),
							},
						}),
					),
				)
				assert.deepStrictEqual(yield* search(gate), Gate.Answer.Allow())
				// The judge decides for the Bot above with its own name, not with the name of the
				// Bot that makes the call.
				assert.deepStrictEqual(yield* Ref.get(judged), [bot.name, boss.name])
			}),
	)
})
