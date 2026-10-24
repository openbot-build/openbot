/**
 * A decision is the answer of a policy to a request:
 * - `Allow`: a rule lets the principal do the act.
 * - `Deny`: a rule stops the principal.
 * - `NotApplicable`: no rule gives an answer.
 *
 * `NotApplicable` is not the same as `Deny`. A check treats it as a "no", but
 * an `Authorizer` with a decider asks the decider first. See
 * `Authorizer.Options.decider`.
 *
 * @stability stable
 * @since 0.3.0
 */
import * as Data from "effect/Data"
import type * as Rule from "./Rule.ts"

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Decision = Data.TaggedEnum<{
	Allow: {
		/** The rule that gave the answer, when a rule gave it. */
		readonly rule?: Rule.Any
	}
	Deny: {
		/** The rule that gave the answer, when a rule gave it. */
		readonly rule?: Rule.Any
		readonly reason?: string
	}
	NotApplicable: {}
}>

const {
	$is,
	$match,
	Allow: allow,
	Deny: deny,
	NotApplicable: notApplicable,
} = Data.taggedEnum<Decision>()

/**
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const Allow: (args: { readonly rule?: Rule.Any }) => Decision = allow

/**
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const Deny: (args: {
	readonly rule?: Rule.Any
	readonly reason?: string
}) => Decision = deny

/**
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const NotApplicable: Decision = notApplicable()

/**
 * @stability stable
 * @category guards
 * @since 0.3.0
 */
export const isAllow: (
	decision: Decision,
) => decision is Extract<Decision, { readonly _tag: "Allow" }> = $is("Allow")

/**
 * @stability stable
 * @category guards
 * @since 0.3.0
 */
export const isDeny: (
	decision: Decision,
) => decision is Extract<Decision, { readonly _tag: "Deny" }> = $is("Deny")

/**
 * @stability stable
 * @category guards
 * @since 0.3.0
 */
export const isNotApplicable: (
	decision: Decision,
) => decision is Extract<Decision, { readonly _tag: "NotApplicable" }> =
	$is("NotApplicable")

/**
 * Matches each kind of decision.
 *
 * @stability stable
 * @category pattern matching
 * @since 0.3.0
 */
export const match = $match

/**
 * The reason of a decision: the reason of a `Deny`, or the reason of the rule
 * that gave the answer.
 *
 * @stability stable
 * @category getters
 * @since 0.3.0
 */
export const reason = (decision: Decision): string | undefined =>
	decision._tag === "Deny"
		? (decision.reason ?? decision.rule?.reason)
		: decision._tag === "Allow"
			? decision.rule?.reason
			: undefined
