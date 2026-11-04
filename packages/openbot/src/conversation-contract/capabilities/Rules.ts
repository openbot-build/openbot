import { Bots as BotsApi } from "@openbot-build/domain"
import { Context, Effect } from "effect"

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
			BotsApi.RuleNotFound | BotsApi.BotConflict | BotsApi.BotStorageUnavailable
		>
	}
>()("@openbot-build/openbot/conversation-contract/capabilities/Rules") {}

export { type Rule }
