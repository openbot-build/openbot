import { Authorization, type Caller } from "@openbot-build/api"
import { Condition, type Policy, type Rule } from "@nmnmcc/ability"
import { Effect } from "effect"
import { check, type Errors, type Services } from "./Check.ts"

type Scalar = Condition.Scalar

/** Every allow rule in a policy tree, in any place of the tree. */
const allowRules = (node: Policy.Node): ReadonlyArray<Rule.Any> => {
	switch (node._tag) {
		case "Rules":
			return node.rules.filter((rule) => rule._tag === "Allow")
		case "All":
		case "Any":
		case "FirstOf":
			return node.policies.flatMap(allowRules)
		case "Ceiling":
			return [...allowRules(node.cap), ...allowRules(node.policy)]
	}
}

/**
 * The fields that a condition fixes to one value: the `eq` tests with a
 * plain value at the top, or in an `And` at the top. Every value that the
 * condition lets in has these field values.
 */
const fixedFields = (condition: Condition.Ast): Record<string, Scalar> => {
	const output: Record<string, Scalar> = {}
	const parts = condition._tag === "And" ? condition.conditions : [condition]
	for (const part of parts)
		if (
			part._tag === "Compare" &&
			part.op === "eq" &&
			part.value._tag === "Literal"
		)
			output[part.field] = part.value.value
	return output
}

/**
 * Checks that the allow rules of a policy give nothing that the caller can
 * not do. Otherwise anyone who may write roles could give themselves every
 * act.
 *
 * For each allow rule, and each kind and action of it, the rule is tested
 * for the caller as the principal. The check then asks the policy of the
 * caller about every value with the fields that the rule fixes, such as its
 * owner. A rule that fixes no field needs the act on the whole organization.
 * So the check never says yes for a rule that gives more than the caller has.
 */
export const noMoreThanCaller = (
	caller: Caller,
	policy: Authorization.Policy,
): Effect.Effect<void, Errors, Services> =>
	Effect.forEach(
		allowRules(policy.node),
		(rule) => {
			const kinds = rule.resources.includes("*")
				? [...Authorization.OpenBot.resources.keys()]
				: rule.resources
			return Effect.forEach(
				kinds,
				(kind) => {
					const descriptor = Authorization.OpenBot.resources.get(kind)
					if (descriptor === undefined) return Effect.void
					const condition =
						rule.when === undefined
							? Condition.always
							: Condition.partial(rule.when, {
									principal: caller,
									path: descriptor.path,
								})
					// This rule never applies inside the organization of the caller.
					if (condition._tag === "False") return Effect.void
					const actions = rule.actions.includes("*")
						? descriptor.actions
						: rule.actions.filter((action) =>
								descriptor.actions.includes(action),
							)
					const where = {
						...(descriptor.fieldPaths.includes("organizationId")
							? { organizationId: caller.organizationId }
							: {}),
						...fixedFields(condition),
					}
					return Effect.forEach(
						actions,
						(action) => check(caller, { action, kind, where } as never),
						{ discard: true },
					)
				},
				{ discard: true },
			)
		},
		{ discard: true },
	)
