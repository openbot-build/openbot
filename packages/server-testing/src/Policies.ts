import {
	PolicySchema,
	OpenBot,
	type Policy as PolicyModel,
	type Kind,
} from "@openbot-build/domain/Authorization"
import { Condition, Policy } from "@nmnmcc/ability"
import { Schema } from "effect"

/**
 * Makes the JSON of a policy, as a client sends it. The rules come from
 * `Policy.define`, so the types check every kind, action and field. It is an
 * Effect, because the policy goes through its schema.
 */
export const json = <Rules extends Policy.AnyRule>(
	body: (builder: Builder) => Generator<Rules, void, unknown>,
) =>
	Schema.encodeEffect(PolicySchema)(Policy.define(OpenBot)(body) as PolicyModel)

/** The builder of `Policy.define`. */
export type Builder = Policy.Builder<OpenBot>

const $ = Condition.builder<OpenBot, Kind>(OpenBot, "Chat")

/** Everything in the organization of the principal. */
export const inOrganization = {
	when: () => $.under("org", $.principal("organizationId")),
} as const

/** Everything of the user of the principal. */
export const own = {
	when: () =>
		$.under(
			"org",
			$.principal("organizationId"),
			"user",
			$.principal("userId"),
		),
} as const
