import { randomUUID } from "node:crypto"
import { AgentsApi } from "@openbot-build/platform-api"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { AgentRecords } from "../agents/AgentRecords.ts"

type Rule = AgentsApi.Rule

/** The key of a decider in record lists. */
export const deciderKey = (decider: AgentsApi.Decider) =>
	decider._tag === "Person"
		? "person:" + decider.userId
		: decider._tag === "Agent"
			? "agent:" + decider.agent
			: "rule:" + decider.rule

/** Rules in plain language that deciders use to answer the requests of an Agent. */
export class Rules extends Context.Service<
	Rules,
	{
		readonly list: (
			organizationId: string,
			agent: string,
		) => Effect.Effect<ReadonlyArray<Rule>, AgentsApi.AgentStorageUnavailable>
		readonly create: (
			organizationId: string,
			input: {
				readonly agent: AgentsApi.AgentId
				readonly author: AgentsApi.Decider
				readonly text: string
				readonly status: "active" | "proposed"
			},
		) => Effect.Effect<Rule, AgentsApi.AgentStorageUnavailable>
		readonly update: (
			organizationId: string,
			agent: string,
			id: string,
			input: AgentsApi.UpdateRuleRequest,
		) => Effect.Effect<
			Rule,
			| AgentsApi.AgentNotFound
			| AgentsApi.AgentConflict
			| AgentsApi.AgentStorageUnavailable
		>
	}
>()("@openbot-build/platform/capabilities/Rules") {}

export const make: Effect.Effect<typeof Rules.Service, never, AgentRecords> =
	Effect.gen(function* () {
		const records = yield* AgentRecords
		const rules = records.collection("rule", AgentsApi.Rule)
		const put = (organizationId: string, rule: Rule) =>
			rules
				.put(
					{
						organizationId,
						id: rule.id,
						owner: rule.agent,
						scope: deciderKey(rule.author),
						status: rule.status,
					},
					rule,
				)
				.pipe(Effect.as(rule))
		return Rules.of({
			list: (organizationId, agent) =>
				rules.list(organizationId, { owner: agent }),
			create: (organizationId, input) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					return yield* put(organizationId, {
						...input,
						id: "rul_" + randomUUID().replaceAll("-", ""),
						version: 0,
						createdAt: now,
						updatedAt: now,
					})
				}),
			update: (organizationId, agent, id, input) =>
				records.transaction(
					"rule:" + organizationId + ":" + id,
					Effect.gen(function* () {
						const found = yield* rules.find(organizationId, id)
						if (Option.isNone(found) || found.value.agent !== agent)
							return yield* AgentsApi.AgentNotFound.make({ agent: id })
						const rule = found.value
						if (rule.version !== input.expected)
							return yield* AgentsApi.AgentConflict.make({
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
