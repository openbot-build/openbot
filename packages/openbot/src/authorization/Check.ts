import { Authorization, type Caller, Identity } from "@openbot-build/api"
import { type Authorizer, Condition, type Policy } from "@nmnmcc/ability"
import { Effect } from "effect"

/** The service that a check needs. */
export type Services = Authorization.Auth

type OpenBot = Authorization.OpenBot
/** The errors of a check. */
export type Errors =
	Authorizer.Forbidden | Authorizer.Pending | Authorizer.PolicyUnavailable

/**
 * Checks one act for a caller, in a handler, a service or a capability check.
 * Use it when the resource depends on data that the path does not show.
 * It fails with `Forbidden` when the policy says no.
 */
export const check = (
	caller: Caller,
	target: Authorizer.Target<OpenBot>,
): Effect.Effect<void, Errors, Services> =>
	Authorization.Auth.check(target).pipe(Effect.provideService(Identity, caller))

/** Like {@link check}, but gives `false` for a "no". */
export const allows = (
	caller: Caller,
	target: Authorizer.Target<OpenBot>,
): Effect.Effect<boolean, Authorizer.PolicyUnavailable, Services> =>
	check(caller, target).pipe(
		Effect.as(true),
		Effect.catchTags({
			Forbidden: () => Effect.succeed(false),
			Pending: () => Effect.succeed(false),
		}),
	)

/**
 * Fails with the error of `hide` when the caller may not read the resource,
 * so the caller can not learn that it exists. Then it checks the act.
 */
export const guard = <const T extends Policy.Target<OpenBot>, E>(
	caller: Caller,
	target: T,
	options: Authorizer.GuardOptions<OpenBot, E, T["resource"]["_tag"]>,
): Effect.Effect<void, E | Errors, Services> =>
	Authorization.Auth.guard(target, options).pipe(
		Effect.provideService(Identity, caller),
	)

/**
 * The condition on the values of a kind that the caller may act on. Change it
 * into SQL with `toWhere`, or test values with {@link matches}. The policy is
 * loaded once for the whole list.
 */
export const filter = (
	caller: Caller,
	target: Policy.KindTarget<OpenBot>,
): Effect.Effect<Condition.Any, Authorizer.PolicyUnavailable, Services> =>
	Authorization.Auth.filter(target).pipe(
		Effect.provideService(Identity, caller),
	)

/** Tests a resource value against a condition from {@link filter}. */
export const matches = (condition: Condition.Any, value: object) =>
	// OpenBot policies have no predicates, so the condition runs at once. The
	// `Opaque` marker only stops a condition from becoming JSON.
	Condition.evaluateSync(condition as Condition.Condition, { value })
