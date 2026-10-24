/**
 * An authorizer is an Effect service that makes decisions for the principal
 * of the current request.
 *
 * You make the service class, in the same way as `Context.Service`. Give the
 * services that the principal and the decider need as `requires`, and their
 * errors as `error`:
 *
 * ```ts
 * class Auth extends Authorizer.Service<Auth, { requires: Identity }>()(
 *   "app/Auth",
 *   App,
 * ) {}
 * ```
 *
 * Then give a layer with {@link layer}. It says where the principal comes
 * from and how to load its policy. The policy of each principal is loaded
 * once and kept in a cache for a short time.
 *
 * Then use the service in a handler:
 *
 * ```ts
 * yield* Auth.check({ action: "update", resource: bot })
 * ```
 *
 * A "no" answer goes into the error channel as {@link Forbidden}. When the
 * policy can not be loaded, the check fails with {@link PolicyUnavailable}.
 * So the check fails closed: an error is never a "yes".
 *
 * When no rule gives an answer, the authorizer asks the decider, if there is
 * one. A decider may answer at once, or fail with {@link Pending} when a person
 * or a Bot must answer later.
 *
 * @stability stable
 * @since 0.3.0
 */
import type * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type * as Condition from "./Condition.ts"
import type * as Decision from "./Decision.ts"
import type * as Domain from "./Domain.ts"
import * as internal from "./internal/authorizer.ts"
import type * as Policy from "./Policy.ts"

/**
 * The error when a policy says no.
 *
 * @stability stable
 * @category errors
 * @since 0.3.0
 */
export const Forbidden: typeof internal.Forbidden = internal.Forbidden

/**
 * @stability stable
 * @category errors
 * @since 0.3.0
 */
export type Forbidden = internal.Forbidden

/**
 * The error when the policy of the principal can not be loaded. The cause is
 * kept, but it is not shown to the client.
 *
 * @stability stable
 * @category errors
 * @since 0.3.0
 */
export const PolicyUnavailable: typeof internal.PolicyUnavailable =
	internal.PolicyUnavailable

/**
 * @stability stable
 * @category errors
 * @since 0.3.0
 */
export type PolicyUnavailable = internal.PolicyUnavailable

/**
 * The error when a decider must wait for an answer. `ticket` names the
 * request that waits, so the client can come back for the answer.
 *
 * @stability stable
 * @category errors
 * @since 0.3.0
 */
export const Pending: typeof internal.Pending = internal.Pending

/**
 * @stability stable
 * @category errors
 * @since 0.3.0
 */
export type Pending = internal.Pending

/**
 * The services and the errors of the principal and the decider of an
 * authorizer.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Config {
	readonly requires?: unknown
	readonly error?: unknown
}

type RequiresOf<C> = C extends { readonly requires: infer R } ? R : never
type ErrorOf<C> = C extends { readonly error: infer E } ? E : never

/**
 * What a check is about: an act on a resource value, or an act on a kind of
 * resource. A check on a kind passes only when the policy allows the act on
 * every value of the kind.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Target<D> = Policy.Target<D> | Policy.KindTarget<D>

/**
 * A request to the decider.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type DeciderRequest<D> = Policy.Request<D> | Policy.KindRequest<D>

/**
 * The options of a guard.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface GuardOptions<D, E2> {
	/** The action that lets the principal see the resource. The default is `"read"`. */
	readonly read?: Domain.AnyAction<D>
	/** The error when the principal may not see the resource. */
	readonly hide: () => E2
}

/**
 * The service.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Authorizer<D extends Domain.Any, E, R> {
	readonly domain: D
	/** The principal of the current request. */
	readonly principal: Effect.Effect<Domain.Principal<D>, E, R>
	/** The policy of the principal of the current request. */
	readonly policy: Effect.Effect<Policy.Policy<D, E>, PolicyUnavailable | E, R>
	/** Gives the decision of the policy. It does not ask the decider. */
	readonly decide: (
		target: Policy.Target<D>,
	) => Effect.Effect<Decision.Decision, PolicyUnavailable | E, R>
	/** Succeeds when the principal may do the act, and fails when it may not. */
	readonly check: (
		target: Target<D>,
	) => Effect.Effect<void, Forbidden | Pending | PolicyUnavailable | E, R>
	/**
	 * Checks the read action first, and fails with the error of `hide` when the
	 * principal may not see the resource. Then it checks the act. Use it to
	 * answer "not found" to a principal that may not know that a resource
	 * exists.
	 */
	readonly guard: <E2>(
		target: Policy.Target<D>,
		options: GuardOptions<D, E2>,
	) => Effect.Effect<void, E2 | Forbidden | Pending | PolicyUnavailable | E, R>
	/**
	 * Gives the condition on resource values that the principal may act on.
	 * Change it into a query with `Condition.fold`.
	 */
	readonly filter: (
		target: Policy.KindTarget<D>,
	) => Effect.Effect<
		Condition.Condition<E, never, Condition.Opaque>,
		PolicyUnavailable | E,
		R
	>
	/** Gives the fields of a value that the principal may use. */
	readonly permittedFields: (
		target: Omit<Policy.Target<D>, "field">,
	) => Effect.Effect<ReadonlyArray<string>, PolicyUnavailable | E, R>
	/**
	 * Removes the cached policy of a principal, or of every principal. Call it
	 * after a change to the rules or roles of a principal.
	 */
	readonly invalidate: (principal?: Domain.Principal<D>) => Effect.Effect<void>
}

/**
 * The class made by {@link Service}. The static functions use the service
 * from the context.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface ServiceClass<
	Self,
	Id extends string,
	D extends Domain.Any,
	E,
	R,
> extends Context.ServiceClass<Self, Id, Authorizer<D, E, R>> {
	readonly domain: D
	readonly decide: (
		target: Policy.Target<D>,
	) => Effect.Effect<Decision.Decision, PolicyUnavailable | E, R | Self>
	readonly check: (
		target: Target<D>,
	) => Effect.Effect<
		void,
		Forbidden | Pending | PolicyUnavailable | E,
		R | Self
	>
	readonly guard: <E2>(
		target: Policy.Target<D>,
		options: GuardOptions<D, E2>,
	) => Effect.Effect<
		void,
		E2 | Forbidden | Pending | PolicyUnavailable | E,
		R | Self
	>
	readonly filter: (
		target: Policy.KindTarget<D>,
	) => Effect.Effect<
		Condition.Condition<E, never, Condition.Opaque>,
		PolicyUnavailable | E,
		R | Self
	>
	readonly permittedFields: (
		target: Omit<Policy.Target<D>, "field">,
	) => Effect.Effect<ReadonlyArray<string>, PolicyUnavailable | E, R | Self>
}

/**
 * Any service class made by {@link Service}.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type AnyServiceClass = Context.Key<any, any> & {
	readonly domain: Domain.Any
}

/**
 * Makes an authorizer service class for a domain.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const Service: <Self, C extends Config = {}>() => <
	const Id extends string,
	D extends Domain.Any,
>(
	id: Id,
	domain: D,
) => ServiceClass<Self, Id, D, ErrorOf<C>, RequiresOf<C>> =
	internal.Service as never

/**
 * The options of {@link layer}.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Options<D extends Domain.Any, E, R, EL, RL, RP> {
	/** Gives the principal of the current request. */
	readonly principal: Effect.Effect<Domain.Principal<D>, E, R>
	/**
	 * Loads the policy of a principal. A failure becomes
	 * {@link PolicyUnavailable}. The services of the predicates of the policy
	 * are taken when the layer is built.
	 */
	readonly policy: (
		principal: Domain.Principal<D>,
	) => Effect.Effect<Policy.Policy<D, E, RP, any>, EL, RL>
	/**
	 * Answers when no rule gives an answer. Without a decider, such a request
	 * fails with {@link Forbidden}.
	 */
	readonly decider?: (
		request: DeciderRequest<D>,
	) => Effect.Effect<Decision.Decision, Pending | E, R>
	/**
	 * How the policies are kept. The default keeps 1000 policies for 30 seconds.
	 * Give `false` to load the policy for each check.
	 */
	readonly cache?:
		| {
				readonly capacity?: number
				readonly timeToLive?: Duration.Input
		  }
		| false
}

/**
 * Makes the layer of an authorizer.
 *
 * @stability stable
 * @category layers
 * @since 0.3.0
 */
export const layer: <
	Self,
	Id extends string,
	D extends Domain.Any,
	E,
	R,
	EL = never,
	RL = never,
	RP = never,
>(
	service: ServiceClass<Self, Id, D, E, R>,
	options: Options<D, NoInfer<E>, NoInfer<R>, EL, RL, RP>,
) => Layer.Layer<Self, never, RL | RP> = internal.layer as never
