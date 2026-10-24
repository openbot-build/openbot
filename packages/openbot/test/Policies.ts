import { type AccountCaller, Authorization } from "@openbot-build/api"
import { type Condition, Policy, type Rule } from "@nmnmcc/ability"
import { Schema } from "effect"

/**
 * Makes the JSON of a policy, as a client sends it. The rules come from
 * `Policy.define`, so the types check every kind, action and field.
 */
export const json = <Rules extends Rule.Any>(
	body: (builder: Builder) => Generator<Rules, void, unknown>,
) =>
	Schema.encodeSync(Authorization.PolicySchema)(
		Policy.define(Authorization.OpenBot)(body) as Authorization.Policy,
	)

/** The builder of `Policy.define`. */
export type Builder = Rule.Builder<Authorization.OpenBot>

/** Everything in the organization of the principal. */
export const inOrganization = {
	when: <B extends Condition.Builder<any, any, AccountCaller>>($: B) =>
		$.under("org", $.principal("organizationId")),
} as const

/** Everything of the user of the principal. */
export const own = {
	when: <B extends Condition.Builder<any, any, AccountCaller>>($: B) =>
		$.under(
			"org",
			$.principal("organizationId"),
			"user",
			$.principal("userId"),
		),
} as const
