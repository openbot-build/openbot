import { Authorization } from "@openbot-build/domain"
import { type Caller, Identity } from "@openbot-build/domain"
import { Condition, Policy } from "@nmnmcc/ability"
import { Array as Arr, Effect, HashMap, Option } from "effect"
import type { Errors } from "./Check.ts"

/** Allows everything. A scope is empty when this policy allows none of it. */
const everything = Policy.define(Authorization.OpenBot)(function* (_) {
	yield* _.allow("*", "*")
})

/** Every allow rule in a policy tree, in any place of the tree. */
const allowRules = (node: Policy.Node): Policy.RulesNode["rules"] => {
	switch (node._tag) {
		case "Rules":
			return Arr.filter(node.rules, (rule) => rule._tag === "Allow")
		case "All":
		case "Any":
		case "FirstOf":
			return Arr.flatMap(node.policies, allowRules)
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
 * is not known, it says no. It uses the authorizer `auth`, so it needs no
 * services. It loads the policy of the caller one time and tests every scope
 * against that one snapshot, so it reads storage once and its answers agree.
 */
export const noMoreThanCaller = (
	auth: typeof Authorization.Auth.Service,
	caller: Caller,
	policy: Authorization.Policy,
): Effect.Effect<void, Errors> =>
	Effect.flatMap(auth.policy, (own) =>
		Effect.forEach(
			allowRules(policy.node),
			(rule) => {
				const kinds = Arr.contains(rule.resources, "*")
					? Arr.fromIterable(HashMap.keys(Authorization.OpenBot.resources))
					: rule.resources
				return Effect.forEach(
					kinds,
					(kind) => {
						const descriptor = HashMap.get(
							Authorization.OpenBot.resources,
							kind,
						)
						// The rules of a member only work in the organization of the
						// member, so a kind outside every organization gives nothing.
						if (
							Option.isNone(descriptor) ||
							descriptor.value.path?.[0] !== "org"
						)
							return Effect.void
						const actions = Arr.contains(rule.actions, "*")
							? descriptor.value.actions
							: Arr.filter(rule.actions, (action) =>
									Arr.contains(descriptor.value.actions, action),
								)
						// A decoded policy keeps its conditions as plain data, so the
						// condition of the rule is a scope as it is.
						const within: Policy.Scope<
							Authorization.OpenBot,
							Authorization.Kind
						> = ($) =>
							$.and(
								$.under("org", $.principal("organizationId")),
								(rule.when ?? Condition.always) as never,
							)
						return Effect.forEach(
							actions,
							(action) => {
								// The kind and the action come from a decoded rule, so
								// only this assertion ties them together.
								const target = {
									action,
									kind,
									within,
								} as Policy.KindTarget<Authorization.OpenBot>
								const request = { ...target, principal: caller }
								const empty =
									Policy.coverage(everything, request)._tag === "None"
								if (empty || Policy.coverage(own, request)._tag === "All")
									return Effect.void
								return Effect.fail(
									Authorization.Forbidden.make({
										action,
										kind,
										reason:
											"A role or a policy may not give more than you can do yourself.",
									}),
								)
							},
							{ discard: true },
						)
					},
					{ discard: true },
				)
			},
			{ discard: true },
		),
	).pipe(Effect.provideService(Identity, caller))
