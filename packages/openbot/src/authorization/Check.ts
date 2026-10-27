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
 * The checks of a caller, with one authorizer. Their effects need no
 * services, so a service that takes them when its layer is built keeps
 * `R = never` in its methods.
 */
export interface Checks {
	/**
	 * Checks one act for a caller, in a handler, a service or a capability
	 * check. Use it when the resource depends on data that the path does not
	 * show. It fails with `Forbidden` when the policy says no.
	 */
	readonly check: (
		caller: Caller,
		target: Authorizer.Target<OpenBot>,
	) => Effect.Effect<void, Errors>
	/** Like `check`, but gives `false` for a "no". */
	readonly allows: (
		caller: Caller,
		target: Authorizer.Target<OpenBot>,
	) => Effect.Effect<boolean, Authorizer.PolicyUnavailable>
	/**
	 * Fails with the error of `hide` when the caller may not read the
	 * resource, so the caller can not learn that it exists. Then it checks the
	 * act.
	 */
	readonly guard: <const T extends Policy.Target<OpenBot>, E>(
		caller: Caller,
		target: T,
		options: Authorizer.GuardOptions<OpenBot, E, T["resource"]["_tag"]>,
	) => Effect.Effect<void, E | Errors>
	/**
	 * The condition on the values of a kind that the caller may act on. Change
	 * it into SQL with `toWhere`, or test values with {@link matches}. The
	 * policy is loaded once for the whole list.
	 */
	readonly filter: (
		caller: Caller,
		target: Policy.KindTarget<OpenBot>,
	) => Effect.Effect<Condition.Any, Authorizer.PolicyUnavailable>
}

/**
 * Takes the authorizer from the context and gives the checks that use it. A
 * service yields it once, when its layer is built.
 */
export const make: Effect.Effect<Checks, never, Services> = Effect.map(
	Authorization.Auth,
	(auth): Checks => {
		const check: Checks["check"] = (caller, target) =>
			auth.check(target).pipe(Effect.provideService(Identity, caller))
		return {
			check,
			allows: (caller, target) =>
				check(caller, target).pipe(
					Effect.as(true),
					Effect.catchTags({
						Forbidden: () => Effect.succeed(false),
						Pending: () => Effect.succeed(false),
					}),
				),
			guard: (caller, target, options) =>
				auth
					.guard(target, options)
					.pipe(Effect.provideService(Identity, caller)),
			filter: (caller, target) =>
				auth.filter(target).pipe(Effect.provideService(Identity, caller)),
		}
	},
)

/** Tests a resource value against a condition from {@link Checks.filter}. */
export const matches = (condition: Condition.Any, value: object) =>
	// OpenBot policies have no predicates, so the condition runs at once. The
	// `Opaque` marker only stops a condition from becoming JSON.
	Condition.evaluateSync(condition as Condition.Condition, { value })
