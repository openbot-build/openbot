/**
 * A policy is a tree that gives a {@link Decision.Decision} for a request.
 *
 * The leaves of the tree are lists of rules. A combining algorithm decides
 * which rule gives the answer when more than one rule applies:
 * - `denyOverrides` (the default): a deny rule wins over every allow rule.
 * - `permitOverrides`: an allow rule wins over every deny rule.
 * - `firstApplicable`: the first rule that applies wins.
 * - `lastApplicable`: the last rule that applies wins.
 *
 * The branches put policies together:
 * - {@link all}: every policy must allow, and one deny is enough to deny. Use
 *   it when a user token may never do more than its user.
 * - {@link any}: one allow is enough.
 * - {@link firstOf}: the first policy that gives an answer wins. Use it for
 *   grants first, then rules.
 * - {@link ceiling}: the deny rules of a second policy are a limit for
 *   everyone. Its allow rules do nothing.
 *
 * A policy gives three kinds of answers:
 * - {@link decide}: the decision for one resource value.
 * - {@link residual}: a condition on resource values. A value passes when the
 *   policy allows the request for that value. Use it to make a database
 *   query, or to ask "may this principal do this act on some resource of
 *   this kind?"
 * - {@link permittedFields}: the fields that the policy lets a request use.
 *
 * A policy without predicates can become JSON with {@link schema}.
 *
 * @stability stable
 * @since 0.3.0
 */
import type * as Effect from "effect/Effect"
import type * as Equal from "effect/Equal"
import type * as Inspectable from "effect/Inspectable"
import type * as Pipeable from "effect/Pipeable"
import type * as Schema from "effect/Schema"
import type * as Condition from "./Condition.ts"
import type * as Decision from "./Decision.ts"
import type * as Domain from "./Domain.ts"
import * as internal from "./internal/policy.ts"
import type * as Rule from "./Rule.ts"

/**
 * @stability stable
 * @category type IDs
 * @since 0.3.0
 */
export const TypeId: "~@nmnmcc/ability/Policy" = internal.TypeId

/**
 * @stability stable
 * @category type IDs
 * @since 0.3.0
 */
export type TypeId = typeof TypeId

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Algorithm =
	"denyOverrides" | "permitOverrides" | "firstApplicable" | "lastApplicable"

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface RulesNode {
	readonly _tag: "Rules"
	readonly algorithm: Algorithm
	readonly rules: ReadonlyArray<Rule.Any>
}

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface AllNode {
	readonly _tag: "All"
	readonly policies: ReadonlyArray<Node>
}

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface AnyNode {
	readonly _tag: "Any"
	readonly policies: ReadonlyArray<Node>
}

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface FirstOfNode {
	readonly _tag: "FirstOf"
	readonly policies: ReadonlyArray<Node>
}

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface CeilingNode {
	readonly _tag: "Ceiling"
	readonly cap: Node
	readonly policy: Node
}

/**
 * The nodes of a policy tree.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Node = RulesNode | AllNode | AnyNode | FirstOfNode | CeilingNode

/**
 * A policy for the domain `D`. `E`, `R` and `O` come from the conditions of
 * its rules. See `Condition.Condition`.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Policy<D extends Domain.Any, E = never, R = never, O = never>
	extends Equal.Equal, Inspectable.Inspectable, Pipeable.Pipeable {
	readonly [TypeId]: TypeId
	readonly domain: D
	readonly node: Node
	readonly "~Policy"?: Condition.Variance<E, R, O>
}

/**
 * Any policy.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Any = Policy<any, any, any, any>

/**
 * The domain of a policy.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type DomainOf<P> = P extends Policy<infer D, any, any, any> ? D : never

/**
 * The error type of a policy.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Error<P> = P extends {
	readonly "~Policy"?: Condition.Variance<infer E, infer _R, infer _O>
}
	? E
	: never

/**
 * The service type of a policy.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Services<P> = P extends {
	readonly "~Policy"?: Condition.Variance<infer _E, infer R, infer _O>
}
	? R
	: never

/**
 * `Condition.Opaque` when a policy has a predicate.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type OpaqueOf<P> = P extends {
	readonly "~Policy"?: Condition.Variance<infer _E, infer _R, infer O>
}
	? O
	: never

/**
 * One act on one resource value, for each kind of the domain. The action must
 * be an action of the kind, and the field must be a field of the kind.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Target<D> = {
	[K in Domain.Kind<D>]: {
		readonly action: Domain.ActionOf<D, K>
		readonly resource: Domain.ValueOf<D, K>
		readonly field?: Condition.FieldPath<Domain.DataOf<D, K>>
	}
}[Domain.Kind<D>]

/**
 * Known values of some fields of a kind. Only fields with a plain value
 * (a string, a number, a boolean or `null`) may be given.
 *
 * @stability stable
 * @category models
 * @since 0.4.0
 */
export type Where<Data> = {
	readonly [
		F in keyof Data as Data[F] extends Condition.Scalar ? F : never
	]?: Data[F]
}

/**
 * One act on one kind of resource, with no value.
 *
 * With `where`, the target is the part of the kind with these field values,
 * such as "the Bots of this user". A check on it passes when the policy allows
 * the act on every value of that part.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type KindTarget<D> = {
	[K in Domain.Kind<D>]: {
		readonly action: Domain.ActionOf<D, K>
		readonly kind: K
		readonly field?: Condition.FieldPath<Domain.DataOf<D, K>>
		readonly where?: Where<Domain.DataOf<D, K>>
	}
}[Domain.Kind<D>]

/**
 * A request: a principal, an action, and a resource value.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Request<D> = Target<D> & { readonly principal: Domain.Principal<D> }

/**
 * A request about a kind of resource, with no value.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type KindRequest<D> = KindTarget<D> & {
	readonly principal: Domain.Principal<D>
}

/**
 * A request with no types.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface AnyRequest {
	readonly principal: object
	readonly action: string
	readonly resource: object
	readonly field?: string | undefined
}

/**
 * One rule that a decision tested. `path` gives the place of the rule in the
 * policy tree: the index of each child, then the index of the rule.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Step {
	readonly path: ReadonlyArray<number>
	readonly rule: Rule.Any
	readonly applies: boolean
}

/**
 * A decision, and the rules that were tested to make it, in order. Keep it in
 * an audit log.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Explanation {
	readonly decision: Decision.Decision
	readonly steps: ReadonlyArray<Step>
}

/**
 * The options of a list of rules.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Options {
	/** The default is `denyOverrides`. */
	readonly algorithm?: Algorithm
}

/**
 * Makes a policy from a generator function that gives rules. It is pure and it
 * gives its result at once.
 *
 * @example
 * ```ts
 * const policy = Policy.define(App)(function* (_) {
 *   yield* _.allow("read", Bot)
 *   yield* _.allow(["update", "delete"], Bot, {
 *     when: ($) => $.eq("ownerUserId", $.principal("userId")),
 *   })
 * })
 * ```
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const define: <D extends Domain.Any>(
	domain: D,
	options?: Options,
) => <Rules extends Rule.Any, A>(
	body: (builder: Rule.Builder<D>) => Generator<Rules, A, unknown>,
) => Policy<D, Rule.Error<Rules>, Rule.Services<Rules>, Rule.OpaqueOf<Rules>> =
	internal.define as never

/**
 * Makes a policy from a list of rules.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const rules: <D extends Domain.Any, Rules extends Rule.Any>(
	domain: D,
	rules: Iterable<Rules>,
	options?: Options,
) => Policy<D, Rule.Error<Rules>, Rule.Services<Rules>, Rule.OpaqueOf<Rules>> =
	internal.rules

/**
 * A policy with no rules. It is not applicable to any request.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const empty: <D extends Domain.Any>(domain: D) => Policy<D> =
	internal.empty

type Combined<D extends Domain.Any, Ps extends ReadonlyArray<Any>> = Policy<
	D,
	Error<Ps[number]>,
	Services<Ps[number]>,
	OpaqueOf<Ps[number]>
>

/**
 * Every policy must allow, and one deny is enough to deny. With some policies
 * not applicable and none that deny, the result is not applicable.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const all: <
	const Ps extends readonly [Policy<any, any, any, any>, ...Array<Any>],
>(
	policies: Ps,
) => Combined<DomainOf<Ps[0]>, Ps> = internal.all

/**
 * One allow is enough. Without an allow, one deny gives a deny.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const any: <
	const Ps extends readonly [Policy<any, any, any, any>, ...Array<Any>],
>(
	policies: Ps,
) => Combined<DomainOf<Ps[0]>, Ps> = internal.any

/**
 * The first policy that allows or denies gives the answer.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const firstOf: <
	const Ps extends readonly [Policy<any, any, any, any>, ...Array<Any>],
>(
	policies: Ps,
) => Combined<DomainOf<Ps[0]>, Ps> = internal.firstOf

/**
 * Puts a limit on a policy. A deny from `cap` always wins. An allow from `cap`
 * does nothing.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const ceiling: {
	<D extends Domain.Any, E2, R2, O2>(
		cap: Policy<D, E2, R2, O2>,
	): <E, R, O>(policy: Policy<D, E, R, O>) => Policy<D, E | E2, R | R2, O | O2>
	<D extends Domain.Any, E, R, O, E2, R2, O2>(
		policy: Policy<D, E, R, O>,
		cap: Policy<D, E2, R2, O2>,
	): Policy<D, E | E2, R | R2, O | O2>
} = internal.ceiling

/**
 * Gives the decision of a policy for a request.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const decide: {
	<D extends Domain.Any>(
		request: Request<D>,
	): <E, R, O>(
		policy: Policy<D, E, R, O>,
	) => Effect.Effect<Decision.Decision, E, R>
	<D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O>,
		request: Request<NoInfer<D>>,
	): Effect.Effect<Decision.Decision, E, R>
} = internal.decide as never

/**
 * Gives the decision of a policy with no predicates, at once.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const decideSync: {
	<D extends Domain.Any>(
		request: Request<D>,
	): (policy: Policy<D>) => Decision.Decision
	<D extends Domain.Any>(
		policy: Policy<D>,
		request: Request<NoInfer<D>>,
	): Decision.Decision
} = internal.decideSync

/**
 * Gives the decision of a policy and the rules that were tested to make it.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const explain: {
	<D extends Domain.Any>(
		request: Request<D>,
	): <E, R, O>(policy: Policy<D, E, R, O>) => Effect.Effect<Explanation, E, R>
	<D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O>,
		request: Request<NoInfer<D>>,
	): Effect.Effect<Explanation, E, R>
} = internal.explain as never

/**
 * Gives the condition on resource values for which the policy allows a
 * request. It has no principal fields and no `Under` nodes, so you can give it
 * to `Condition.fold`. It is `True` when the policy allows every value of the
 * kind, and `False` when it allows none.
 *
 * With `where`, the known field values are put into the condition, as with
 * `Condition.assign`. Then `True` means that the policy allows every value with
 * these field values.
 *
 * Predicates stay in the condition. They take the principal with them.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const residual: {
	<D extends Domain.Any>(
		request: KindRequest<D>,
	): <E, R, O>(policy: Policy<D, E, R, O>) => Condition.Condition<E, R, O>
	<D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O>,
		request: KindRequest<NoInfer<D>>,
	): Condition.Condition<E, R, O>
} = internal.residual as never

/**
 * Gives the fields of a resource value that the policy lets a request use. It
 * tests each field of the resource Schema, with dots for nested fields.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const permittedFields: {
	<D extends Domain.Any>(
		request: Omit<Request<D>, "field">,
	): <E, R, O>(
		policy: Policy<D, E, R, O>,
	) => Effect.Effect<ReadonlyArray<string>, E, R>
	<D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O>,
		request: Omit<Request<NoInfer<D>>, "field">,
	): Effect.Effect<ReadonlyArray<string>, E, R>
} = internal.permittedFields as never

/**
 * The JSON form of a rule.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface EncodedRule {
	readonly _tag: "Allow" | "Deny"
	readonly actions: ReadonlyArray<string>
	readonly resources: ReadonlyArray<string>
	readonly when?: Condition.Encoded
	readonly fields?: ReadonlyArray<string>
	readonly reason?: string
	readonly id?: string
	readonly meta?: unknown
}

/**
 * The JSON form of a policy.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type EncodedNode =
	| {
			readonly _tag: "Rules"
			readonly algorithm: Algorithm
			readonly rules: ReadonlyArray<EncodedRule>
	  }
	| {
			readonly _tag: "All" | "Any" | "FirstOf"
			readonly policies: ReadonlyArray<EncodedNode>
	  }
	| {
			readonly _tag: "Ceiling"
			readonly cap: EncodedNode
			readonly policy: EncodedNode
	  }

/**
 * The Schema of the policies of a domain with no predicates. Decoding checks
 * every kind, action, field and principal field against the domain, and the
 * `meta` of each rule against the `meta` Schema of the domain.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export const schema: <D extends Domain.Any>(
	domain: D,
) => Schema.Codec<Policy<D>, EncodedNode> = internal.schema

/**
 * Tests if a value is a policy.
 *
 * @stability stable
 * @category guards
 * @since 0.3.0
 */
export const isPolicy: (u: unknown) => u is Any = internal.isPolicy
