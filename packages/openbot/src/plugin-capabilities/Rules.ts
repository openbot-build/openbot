import { Bots as BotsApi } from "@openbot-build/domain"
import { Clock, Effect, Layer, Option, String as Str } from "effect"
import { SecureRandom } from "effect/crypto"
import { BotRecords } from "../conversation-contract/bots/BotRecords.ts"
import {
	type Rule,
	deciderKey,
	Rules,
} from "../conversation-contract/capabilities/Rules.ts"
export {
	deciderKey,
	Rules,
} from "../conversation-contract/capabilities/Rules.ts"

export const make: Effect.Effect<
	typeof Rules.Service,
	never,
	BotRecords | SecureRandom.SecureRandom
> = Effect.gen(function* () {
	const records = yield* BotRecords
	const crypto = yield* SecureRandom.SecureRandom
	const newId = crypto
		.uuidV7()
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
					id: BotsApi.RuleId.make("rul_" + (yield* newId)),
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
						return yield* BotsApi.RuleNotFound.make({
							rule: BotsApi.RuleId.make(id),
						})
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
