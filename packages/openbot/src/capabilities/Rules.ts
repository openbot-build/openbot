import { BotsApi } from "@openbot-build/api"
import {
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	String as Str,
} from "effect"
import { BotRecords } from "../bots/BotRecords.ts"

type Rule = BotsApi.Rule

/** The key of a decider in record lists. */
export const deciderKey = (decider: BotsApi.Decider) =>
	decider._tag === "Person"
		? "person:" + decider.userId
		: decider._tag === "Bot"
			? "bot:" + decider.bot
			: "rule:" + decider.rule

/** Rules in plain language that deciders use to answer the requests of a Bot. */
export class Rules extends Context.Service<
	Rules,
	{
		readonly list: (
			organizationId: string,
			bot: string,
		) => Effect.Effect<ReadonlyArray<Rule>, BotsApi.BotStorageUnavailable>
		readonly create: (
			organizationId: string,
			input: {
				readonly bot: BotsApi.BotId
				readonly author: BotsApi.Decider
				readonly text: string
				readonly status: "active" | "proposed"
			},
		) => Effect.Effect<Rule, BotsApi.BotStorageUnavailable>
		readonly update: (
			organizationId: string,
			bot: string,
			id: string,
			input: BotsApi.UpdateRuleRequest,
		) => Effect.Effect<
			Rule,
			BotsApi.BotNotFound | BotsApi.BotConflict | BotsApi.BotStorageUnavailable
		>
	}
>()("@openbot-build/openbot/capabilities/Rules") {}

export const make: Effect.Effect<
	typeof Rules.Service,
	never,
	BotRecords | Crypto.Crypto
> = Effect.gen(function* () {
	const records = yield* BotRecords
	const crypto = yield* Crypto.Crypto
	const newId = crypto
		.randomUUIDv4()
		.pipe(Effect.orDie, Effect.map(Str.replaceAll("-", "")))
	const rules = records.collection("rule", BotsApi.Rule, BotsApi.RuleStatus)
	const put = (organizationId: string, rule: Rule) =>
		rules
			.put(
				{
					organizationId,
					id: rule.id,
					owner: rule.bot,
					scope: deciderKey(rule.author),
					status: rule.status,
				},
				rule,
			)
			.pipe(Effect.as(rule))
	return Rules.of({
		list: (organizationId, bot) => rules.list(organizationId, { owner: bot }),
		create: (organizationId, input) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				return yield* put(organizationId, {
					...input,
					id: "rul_" + (yield* newId),
					version: 0,
					createdAt: now,
					updatedAt: now,
				})
			}),
		update: (organizationId, bot, id, input) =>
			records.transaction(
				"rule:" + organizationId + ":" + id,
				Effect.gen(function* () {
					const found = yield* rules.find(organizationId, id)
					if (Option.isNone(found) || found.value.bot !== bot)
						return yield* BotsApi.BotNotFound.make({ bot: id })
					const rule = found.value
					if (rule.version !== input.expected)
						return yield* BotsApi.BotConflict.make({
							message: "The Rule changed. Read it again and retry.",
						})
					const now = yield* Clock.currentTimeMillis
					return yield* put(organizationId, {
						...rule,
						...(input.text === undefined ? {} : { text: input.text }),
						...(input.status === undefined ? {} : { status: input.status }),
						version: rule.version + 1,
						updatedAt: now,
					})
				}),
			),
	})
})
export const layer = Layer.effect(Rules, make)
