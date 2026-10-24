import { Authorization, type Caller, Identity } from "@openbot-build/api"
import { Condition, Policy, type Rule } from "@nmnmcc/ability"
import { Effect, HashMap, Option } from "effect"
import type { Errors, Services } from "./Check.ts"

/** Allows everything. A scope is empty when this policy allows none of it. */
const everything = Policy.define(Authorization.OpenBot)(function* (_) {
	yield* _.allow("*", "*")
})

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
 * Checks that the allow rules of a policy give nothing that the caller can
 * not do. Otherwise anyone who may write roles could give themselves every
 * act.
 *
 * Each allow rule, for each of its kinds and actions, is a scope: the values
 * that it allows inside the organization, with the caller as the principal.
 * The policy of the caller must allow every value in that scope. An empty
 * scope gives nothing, so it passes. The check fails closed: when the answer
 * is not known, it says no.
 */
export const noMoreThanCaller = (
	caller: Caller,
	policy: Authorization.Policy,
): Effect.Effect<void, Errors, Services> =>
	Effect.forEach(
		allowRules(policy.node),
		(rule) => {
			const kinds = rule.resources.includes("*")
				? Array.from(HashMap.keys(Authorization.OpenBot.resources))
				: rule.resources
			return Effect.forEach(
				kinds,
				(kind) => {
					const descriptor = HashMap.get(Authorization.OpenBot.resources, kind)
					// The rules of a member only work in the organization of the
					// member, so a kind outside every organization gives nothing.
					if (Option.isNone(descriptor) || descriptor.value.path?.[0] !== "org")
						return Effect.void
					const actions = rule.actions.includes("*")
						? descriptor.value.actions
						: rule.actions.filter((action) =>
								descriptor.value.actions.includes(action),
							)
					// A decoded policy keeps its conditions as plain data, so the
					// condition of the rule is a scope as it is.
					const within = ($: Condition.Builder<any, any, any>) =>
						$.and(
							$.under("org", $.principal("organizationId")),
							(rule.when ?? Condition.always) as never,
						)
					return Effect.forEach(
						actions,
						(action) =>
							Effect.gen(function* () {
								const target = { action, kind, within } as never
								const empty =
									Policy.coverage(everything, {
										...(target as object),
										principal: caller,
									} as never)._tag === "None"
								if (empty) return
								const coverage = yield* Authorization.Auth.coverage(target)
								if (coverage._tag === "All") return
								return yield* Authorization.Forbidden.make({
									action,
									kind,
									reason:
										"A role or a policy may not give more than you can do yourself.",
								})
							}),
						{ discard: true },
					)
				},
				{ discard: true },
			)
		},
		{ discard: true },
	).pipe(Effect.provideService(Identity, caller))
