/**
 * The Grants of a Bot as an ability policy. Each Grant is one rule, with the
 * ID of the Grant. A deny Grant wins over an allow Grant, as
 * `denyOverrides` says.
 */
import { BotsApi } from "@openbot-build/api"
import { Domain, Policy, Resource } from "@nmnmcc/ability"
import { Array as Arr, Effect, Option, Schema } from "effect"
import type { Chat } from "@openbot-build/core"

/** The Bot that tries a capability, in one Chat. */
const BotCaller = Schema.Struct({ bot: Schema.String, chat: Schema.String })

/**
 * One capability request. `arguments` is the JSON text of the arguments, or
 * `{}` when there are none. `chat` is the Chat of the request.
 */
export class CapabilityRequest extends Resource.Class<CapabilityRequest>()(
	"Capability",
	{
		actions: BotsApi.CapabilityAction.literals,
		fields: {
			target: Schema.String,
			arguments: Schema.String,
			chat: Schema.String,
		},
	},
) {}

export const Capabilities = Domain.make({
	principal: BotCaller,
	resources: [CapabilityRequest],
})

/**
 * The policy of a list of Grants. A Grant with the target `*` covers every
 * target. A Grant with arguments covers only the same arguments, and a Grant
 * with no arguments covers any arguments. A Chat Grant counts only in its
 * own Chat.
 */
export const policyOf = (grants: ReadonlyArray<BotsApi.Grant>) =>
	Policy.define(Capabilities)(function* (_) {
		for (const grant of grants) {
			const { capability } = grant
			const make = grant.effect === "allow" ? _.allow : _.deny
			yield* make(capability.action, CapabilityRequest, {
				id: grant.id,
				when: ($) =>
					$.and(
						...(capability.target === "*"
							? []
							: [$.eq("target", capability.target)]),
						...(capability.arguments === undefined
							? []
							: [
									$.eq("arguments", JSON.stringify(capability.arguments ?? {})),
								]),
						...(grant.scope === "chat" && grant.chat !== undefined
							? [$.eq("chat", grant.chat)]
							: []),
					),
			})
		}
	})

/** The Grant that decides a request, if one does. */
export const decidingGrant = (input: {
	readonly grants: ReadonlyArray<BotsApi.Grant>
	readonly bot: string
	readonly capability: BotsApi.Capability
	readonly chat: Chat.Id
}) => {
	const policy = policyOf(input.grants)
	const request = {
		principal: { bot: input.bot, chat: input.chat },
		action: input.capability.action,
		resource: CapabilityRequest.make({
			target: input.capability.target,
			arguments: JSON.stringify(input.capability.arguments ?? {}),
			chat: input.chat,
		}),
	}
	return Policy.explain(policy, request).pipe(
		Effect.map(({ decision, steps }): Option.Option<BotsApi.Grant> => {
			if (decision._tag === "NotApplicable") return Option.none()
			// The rules are tested in order, so the first rule that applies with
			// the same effect is the one that decides. Its ID is the ID of the Grant.
			const winner = Arr.findFirst(
				steps,
				(step) => step.applies && step.rule._tag === decision._tag,
			)
			return Option.flatMap(winner, (step) =>
				Arr.findFirst(input.grants, (grant) => grant.id === step.rule.id),
			)
		}),
	)
}
