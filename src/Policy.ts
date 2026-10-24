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
 * Each of them also takes the request first and the policy later. In a `pipe`,
 * the policy gives the domain. Outside a `pipe`, give the domain by hand, as
 * in `Policy.decide<typeof App>(request)`. Without it the request has the type
 * `never`, so TypeScript can still check it.
 *
 * A policy without predicates can become JSON with {@link schema}.
 *
 * @stability stable
 * @since 0.3.0
 */
// A policy keeps the error type and the service type of its predicates in the
// public types. The code below works on the nodes with no types, where they
// are `unknown`, so the language service check for `unknown` in an Effect is
// off here.
// @effect-diagnostics anyUnknownInErrorContext:off
import type * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import * as Option from "effect/Option"
import type * as Pipeable from "effect/Pipeable"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as Condition from "./Condition.ts"
import * as Decision from "./Decision.ts"
import * as Domain from "./Domain.ts"
import * as Resource from "./Resource.ts"
import * as Rule from "./Rule.ts"

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
 * The tree of a policy with the types of its predicates and its domain `D`.
 * Each rule and each child has the types too, and `"~Node"` is only in the types. A node made by
 * hand does not have it. So the node of one policy, or a part of it, can not
 * go into a policy with other types.
 *
 * @stability stable
 * @category models
 * @since 0.4.0
 */
export type TypedNode<E = never, R = never, O = never, D = any> = (
	| {
			readonly _tag: "Rules"
			readonly algorithm: Algorithm
			// The rules may read different values, so a node keeps no one type of
			// what they read. With `never`, a condition taken from a node fits no
			// rule that reads a value or a principal.
			readonly rules: ReadonlyArray<Rule.Rule<E, R, O, D, never>>
	  }
	| {
			readonly _tag: "All" | "Any" | "FirstOf"
			readonly policies: ReadonlyArray<TypedNode<E, R, O, D>>
	  }
	| {
			readonly _tag: "Ceiling"
			readonly cap: TypedNode<E, R, O, D>
			readonly policy: TypedNode<E, R, O, D>
	  }
) & {
	readonly "~Node": Condition.Variance<E, R, O>
}

/**
 * A policy for the domain `D`. `E`, `R` and `O` come from the conditions of
 * its rules. See `Condition.Condition`.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Policy<D extends Domain.Any, E = never, R = never, O = never>
	extends Pipeable.Pipeable {
	readonly domain: D
	readonly node: TypedNode<E, R, O, D>
	readonly "~Policy"?: Condition.Variance<E, R, O>
	/**
	 * Only in the types. A policy reads the values and the principal of its
	 * domain, so a policy of one domain is not a policy of a wider domain.
	 */
	readonly "~Domain"?: (domain: D) => D
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
		readonly field?: Condition.FieldSelector<Domain.DataOf<D, K>>
		/** A target has a resource value or a kind, never both. */
		readonly kind?: never
	}
}[Domain.Kind<D>]

/**
 * A {@link Target} with no field. Each kind keeps its own actions.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type FieldlessTarget<D> = {
	[K in Domain.Kind<D>]: {
		readonly action: Domain.ActionOf<D, K>
		readonly resource: Domain.ValueOf<D, K>
		readonly kind?: never
	}
}[Domain.Kind<D>]

/**
 * A scope: a part of a kind, as a condition on its values. It gets a builder
 * with the types of the kind and of the principal, like the condition of a
 * rule. A scope is plain data, so it can not have a predicate.
 *
 * @stability stable
 * @category models
 * @since 0.5.0
 */
export type Scope<D, K extends string> = (
	builder: Condition.Builder<
		Domain.DataOf<D, K>,
		Domain.ValueOf<D, K>,
		Domain.Principal<D>
	>,
) => Condition.Condition<
	never,
	never,
	never,
	Condition.Reads<Domain.ValueOf<D, K>, Domain.Principal<D>>
>

/**
 * One act on one kind of resource, with no value. With `within`, the target is
 * only the values of the kind in the scope. Without it, the target is every
 * value of the kind.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type KindTarget<D> = {
	[K in Domain.Kind<D>]: {
		readonly action: Domain.ActionOf<D, K>
		readonly kind: K
		readonly field?: Condition.FieldSelector<Domain.DataOf<D, K>>
		/** The part of the kind. See {@link Scope}. */
		readonly within?: Scope<D, K>
		/** A target has a resource value or a kind, never both. */
		readonly resource?: never
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
 * A {@link Request} with no field.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type FieldlessRequest<D> = FieldlessTarget<D> & {
	readonly principal: Domain.Principal<D>
}

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

const nodes = Data.taggedEnum<Node>()

const encodeNode = (node: Node): EncodedNode => {
	switch (node._tag) {
		case "Rules":
			return {
				_tag: "Rules",
				algorithm: node.algorithm,
				// The domain of a rule is not in its JSON form.
				rules: node.rules.map(
					({ domain: _domain, ...value }) => ({ ...value }) as EncodedRule,
				),
			}
		case "All":
		case "Any":
		case "FirstOf":
			return { _tag: node._tag, policies: node.policies.map(encodeNode) }
		case "Ceiling":
			return {
				_tag: "Ceiling",
				cap: encodeNode(node.cap),
				policy: encodeNode(node.policy),
			}
	}
}

/**
 * The tree of a policy as a value that `JSON.stringify` keeps with no loss.
 * See `Condition.toJsonValue`.
 */
const jsonNode = (node: EncodedNode): unknown => {
	switch (node._tag) {
		case "Rules":
			return {
				...node,
				rules: Arr.map(node.rules, (value) =>
					value.when === undefined
						? value
						: { ...value, when: Condition.toJsonValue(value.when as Ast) },
				),
			}
		case "All":
		case "Any":
		case "FirstOf":
			return { ...node, policies: Arr.map(node.policies, jsonNode) }
		case "Ceiling":
			return { ...node, cap: jsonNode(node.cap), policy: jsonNode(node.policy) }
	}
}

/**
 * The class of every policy value. Two policies of one domain with the same
 * tree are equal. As JSON, a policy is its tree.
 */
class PolicyData extends Data.Class<{
	readonly domain: Domain.Any
	readonly node: Node
}> {
	toJSON(): unknown {
		return jsonNode(encodeNode(this.node))
	}
}

/** The node of a policy, with no types, for the code below. */
const nodeOf = (policy: Any): Node => policy.node as Node

const fromNode = (domain: Domain.Any, node: Node): any =>
	new PolicyData({ domain, node })

/**
 * Makes a policy from a list of rules.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const rules: <
	D extends Domain.Any,
	Rules extends Rule.Rule<any, any, any, D, never>,
>(
	domain: D,
	rules: Iterable<Rules>,
	options?: Options,
) => Policy<
	D,
	Rule.Error<Rules>,
	Rule.Services<Rules>,
	Rule.OpaqueOf<Rules>
> = (domain, values, options) => {
	const node = nodes.Rules({
		algorithm: options?.algorithm ?? "denyOverrides",
		rules: Array.from(values),
	})
	// A rule from a builder of another domain is a mistake in the code, so it
	// is a defect. Two domains may have the same types, so the types do not
	// find it.
	if (
		Arr.some(node.rules, (value) => {
			const origin = Rule.domainOf(value)
			return origin !== undefined && origin !== domain
		})
	) {
		throw new globalThis.Error(
			"A rule comes from the builder of another domain",
		)
	}
	// A rule from `Rule.make` keeps no domain, so its names are checked here.
	const issues = validate(domain, encodeNode(node))
	if (issues.length > 0) {
		throw new globalThis.Error(
			`A rule does not fit the domain: ${issues.map((issue) => issue.issue).join("; ")}`,
		)
	}
	return fromNode(domain, node)
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
export const define =
	<D extends Domain.Any>(domain: D, options?: Options) =>
	<Rules extends Rule.Rule<any, any, any, D, never>, A>(
		body: (builder: Rule.Builder<D>) => Generator<Rules, A, unknown>,
	): Policy<
		D,
		Rule.Error<Rules>,
		Rule.Services<Rules>,
		Rule.OpaqueOf<Rules>
	> => {
		const iterator = body(Rule.builder(domain))
		// Each rule goes back into the generator, as `yield*` gives it.
		const collected = Arr.unfold(iterator.next(), (state) =>
			state.done === true
				? Option.none()
				: Option.some([state.value, iterator.next(state.value)] as const),
		)
		return rules(domain, collected, options)
	}

/**
 * A policy with no rules. It is not applicable to any request.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const empty = <D extends Domain.Any>(domain: D): Policy<D> =>
	rules(domain, [])

type Combined<D extends Domain.Any, Ps extends ReadonlyArray<Any>> = Policy<
	D,
	Error<Ps[number]>,
	Services<Ps[number]>,
	OpaqueOf<Ps[number]>
>

const sameDomain = (policies: ReadonlyArray<Any>): Domain.Any => {
	const domain = policies[0]!.domain
	if (!Arr.every(policies, (policy) => policy.domain === domain)) {
		throw new globalThis.Error(
			"Policies from two domains can not be put together",
		)
	}
	return domain
}

const combine =
	(tag: "All" | "Any" | "FirstOf") =>
	(policies: ReadonlyArray<Any>): any =>
		fromNode(
			sameDomain(policies),
			nodes[tag]({ policies: policies.map(nodeOf) }),
		)

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
) => Combined<DomainOf<Ps[0]>, Ps> = combine("All")

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
) => Combined<DomainOf<Ps[0]>, Ps> = combine("Any")

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
) => Combined<DomainOf<Ps[0]>, Ps> = combine("FirstOf")

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
} = dual(2, (policy: Any, cap: Any): any =>
	fromNode(
		sameDomain([policy, cap]),
		nodes.Ceiling({ cap: nodeOf(cap), policy: nodeOf(policy) }),
	),
)

/**
 * Gives the answer for a key from a memo, or works it out and keeps it. One
 * node may be a child of many nodes, so each walk over a tree keeps its work
 * on a node in a memo that the walk makes for itself. No memo lives longer
 * than one call.
 *
 * The memo is a native `Map`, because it must find a node by the node itself.
 * An Effect `HashMap` finds a key by `Equal`, and the nodes are Effect data,
 * so it would hash the whole structure of a node, and a shared child again for
 * each path to it.
 */
const remember = <K, A>(memo: Map<K, A>, key: K, work: () => A): A => {
	const cached = memo.get(key)
	if (cached !== undefined) {
		return cached
	}
	const result = work()
	memo.set(key, result)
	return result
}

/** The memos of one walk over a policy tree. */
interface TreeMemo {
	readonly done: Map<Node, Node>
	readonly predicates: Map<Node, boolean>
}

const provideNode = (
	node: Node,
	context: Context.Context<never>,
	memo: TreeMemo = { done: new Map(), predicates: new Map() },
): Node =>
	// A node with no predicate needs no services, and it stays the same node.
	// One node may be a child of many nodes, and it gives one new node.
	!nodeHasPredicate(node, memo.predicates)
		? node
		: remember(memo.done, node, () => provideOnce(node, context, memo))

const provideOnce = (
	node: Node,
	context: Context.Context<never>,
	memo: TreeMemo,
): Node => {
	switch (node._tag) {
		case "Rules":
			return nodes.Rules({
				algorithm: node.algorithm,
				rules: node.rules.map((value) =>
					value.when === undefined || !Condition.hasPredicate(value.when)
						? value
						: Rule.make({
								...value,
								when: Condition.provideContext(value.when, context as never),
							}),
				),
			})
		case "All":
		case "Any":
		case "FirstOf":
			return nodes[node._tag]({
				policies: Arr.map(node.policies, (child) =>
					provideNode(child, context, memo),
				),
			})
		case "Ceiling":
			return nodes.Ceiling({
				cap: provideNode(node.cap, context, memo),
				policy: provideNode(node.policy, context, memo),
			})
	}
}

/**
 * Gives the services in `context` to every predicate of a policy, so the
 * policy needs no services when it runs.
 *
 * @stability stable
 * @category services
 * @since 0.4.0
 */
export const provideContext: {
	<R>(
		context: Context.Context<R>,
	): <D extends Domain.Any, E, O>(
		policy: Policy<D, E, R, O>,
	) => Policy<D, E, never, O>
	<D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O>,
		context: Context.Context<R>,
	): Policy<D, E, never, O>
} = dual(2, (policy: Any, context: Context.Context<never>): any =>
	fromNode(policy.domain, provideNode(nodeOf(policy), context)),
)

// Decisions

interface DecideContext {
	readonly action: string
	readonly kind: string
	readonly field: string | undefined
	readonly input: Condition.Input
	/** The rules that were tested, for {@link explain}. */
	readonly trace: Ref.Ref<ReadonlyArray<Step>> | undefined
	readonly predicates: Map<Node, boolean>
	/**
	 * The decisions of nodes with no predicates. One node may be a child of
	 * many nodes, and its decision is the same each time, so it is made only
	 * one time. A tree with shared nodes may have very many paths.
	 */
	readonly decisions: Map<Node, Decision.Decision>
}

const ruleApplies = (
	value: Rule.Any,
	context: DecideContext,
	path: ReadonlyArray<number>,
): Effect.Effect<boolean, unknown, unknown> => {
	if (!Rule.matchesTarget(value, context)) {
		return Effect.succeed(false)
	}
	const test =
		value.when === undefined
			? Effect.succeed(true)
			: // A rule of a node keeps no type of what it reads. The decision gives
				// it the value and the principal of the request.
				Condition.evaluate(value.when as Condition.Any, context.input)
	const trace = context.trace
	return trace === undefined
		? test
		: Effect.tap(test, (applies) =>
				Ref.update(trace, Arr.append({ path, rule: value, applies })),
			)
}

const fromRule = (value: Rule.Any): Decision.Decision =>
	value._tag === "Allow"
		? Decision.Allow({ rule: value })
		: value.reason === undefined
			? Decision.Deny({ rule: value })
			: Decision.Deny({ rule: value, reason: value.reason })

/** Gives the first rule that applies, in order. */
const firstApplying = (
	candidates: ReadonlyArray<readonly [Rule.Any, number]>,
	context: DecideContext,
	path: ReadonlyArray<number>,
): Effect.Effect<Option.Option<Rule.Any>, unknown, unknown> =>
	Effect.map(
		Effect.findFirst(candidates, ([value, index]) =>
			ruleApplies(value, context, [...path, index]),
		),
		Option.map(([value]) => value),
	)

/** Gives the first result that is found, and tests `next` only when none is. */
const orElse = <A, E, R>(
	first: Effect.Effect<Option.Option<A>, E, R>,
	next: () => Effect.Effect<Option.Option<A>, E, R>,
): Effect.Effect<Option.Option<A>, E, R> =>
	Effect.filterOrElse(first, Option.isSome, next)

const decideRules = (
	node: RulesNode,
	context: DecideContext,
	path: ReadonlyArray<number>,
): Effect.Effect<Decision.Decision, unknown, unknown> => {
	const indexed = Arr.map(node.rules, (value, index) => [value, index] as const)
	const denies = Arr.filter(indexed, ([value]) => value._tag === "Deny")
	const allows = Arr.filter(indexed, ([value]) => value._tag === "Allow")
	const first = (candidates: ReadonlyArray<readonly [Rule.Any, number]>) =>
		firstApplying(candidates, context, path)
	const found = (() => {
		switch (node.algorithm) {
			case "denyOverrides":
				return orElse(first(denies), () => first(allows))
			case "permitOverrides":
				return orElse(first(allows), () => first(denies))
			case "firstApplicable":
				return first(indexed)
			case "lastApplicable":
				return first(Arr.reverse(indexed))
		}
	})()
	return Effect.map(
		found,
		Option.match({ onNone: () => Decision.NotApplicable, onSome: fromRule }),
	)
}

const decideNode = (
	node: Node,
	context: DecideContext,
	path: ReadonlyArray<number>,
): Effect.Effect<Decision.Decision, unknown, unknown> => {
	// A predicate must run each time, and a trace must have each step.
	if (
		context.trace !== undefined ||
		nodeHasPredicate(node, context.predicates)
	) {
		return decideOnce(node, context, path)
	}
	const cached = context.decisions.get(node)
	return cached !== undefined
		? Effect.succeed(cached)
		: Effect.tap(decideOnce(node, context, path), (decision) =>
				Effect.sync(() => context.decisions.set(node, decision)),
			)
}

/** The next step of a walk over children: stop with a decision, or go on. */
type WalkStep<S> =
	| { readonly _tag: "Stop"; readonly decision: Decision.Decision }
	| { readonly _tag: "Next"; readonly state: S }

/**
 * Decides the children in order. After each child, `step` stops with a
 * decision, or gives the state for the next child. After the last child,
 * `end` gives the decision. A child after a stop is not decided, so its
 * predicates do not run.
 */
const walkChildren = <S>(
	children: ReadonlyArray<Node>,
	context: DecideContext,
	path: ReadonlyArray<number>,
	start: S,
	step: (state: S, decision: Decision.Decision) => WalkStep<S>,
	end: (state: S) => Decision.Decision,
): Effect.Effect<Decision.Decision, unknown, unknown> => {
	const go = (
		index: number,
		state: S,
	): Effect.Effect<Decision.Decision, unknown, unknown> =>
		index === children.length
			? Effect.succeed(end(state))
			: Effect.flatMap(
					decideNode(children[index]!, context, [...path, index]),
					(decision) => {
						const next = step(state, decision)
						return next._tag === "Stop"
							? Effect.succeed(next.decision)
							: go(index + 1, next.state)
					},
				)
	return go(0, start)
}

const stop = (decision: Decision.Decision): WalkStep<never> => ({
	_tag: "Stop",
	decision,
})

const next = <S>(state: S): WalkStep<S> => ({ _tag: "Next", state })

const decideOnce = (
	node: Node,
	context: DecideContext,
	path: ReadonlyArray<number>,
): Effect.Effect<Decision.Decision, unknown, unknown> => {
	switch (node._tag) {
		case "Rules":
			return decideRules(node, context, path)
		case "All":
			// One deny is enough to deny. Every child must allow.
			return walkChildren(
				node.policies,
				context,
				path,
				{
					firstAllow: Option.none<Decision.Decision>(),
					allAllow: node.policies.length > 0,
				},
				(state, decision) =>
					decision._tag === "Deny"
						? stop(decision)
						: next({
								firstAllow: Option.orElse(state.firstAllow, () =>
									decision._tag === "Allow"
										? Option.some(decision)
										: Option.none(),
								),
								allAllow: state.allAllow && decision._tag === "Allow",
							}),
				(state) =>
					state.allAllow
						? Option.getOrElse(state.firstAllow, () => Decision.NotApplicable)
						: Decision.NotApplicable,
			)
		case "Any":
			// One allow is enough. Without one, the first deny denies.
			return walkChildren(
				node.policies,
				context,
				path,
				Option.none<Decision.Decision>(),
				(firstDeny, decision) =>
					decision._tag === "Allow"
						? stop(decision)
						: next(
								Option.orElse(firstDeny, () =>
									decision._tag === "Deny"
										? Option.some(decision)
										: Option.none(),
								),
							),
				(firstDeny) =>
					Option.getOrElse(firstDeny, () => Decision.NotApplicable),
			)
		case "FirstOf":
			return walkChildren(
				node.policies,
				context,
				path,
				undefined,
				(_, decision) =>
					decision._tag === "NotApplicable" ? next(undefined) : stop(decision),
				() => Decision.NotApplicable,
			)
		case "Ceiling":
			// A deny of the cap wins. Else the policy decides.
			return Effect.filterOrElse(
				decideNode(node.cap, context, [...path, 0]),
				(capped) => capped._tag === "Deny",
				() => decideNode(node.policy, context, [...path, 1]),
			)
	}
}

/**
 * Tests if a request fits its kind: the action is an action of the kind, and
 * the field, if there is one, is a field of the kind. The types check this,
 * but a value with a union type, or a value from outside, may get past them.
 * A rule for every action (`"*"`) must not cover an action that the kind does
 * not have, so such a request is not applicable.
 *
 * @stability stable
 * @category predicates
 * @since 0.4.0
 */
export const fitsKind = (
	descriptor: Resource.Descriptor,
	request: { readonly action: string; readonly field?: string | undefined },
): boolean =>
	descriptor.actions.includes(request.action) &&
	(request.field === undefined ||
		descriptor.fieldPaths.includes(request.field) ||
		Resource.hasPath(descriptor.schema, request.field))

const makeContext = (
	domain: Domain.Any,
	request: AnyRequest,
	trace: Ref.Ref<ReadonlyArray<Step>> | undefined,
): DecideContext | undefined => {
	const kind = Resource.kindOf(request.resource)
	const descriptor =
		kind === undefined ? undefined : Domain.descriptorOf(domain, kind)
	if (
		kind === undefined ||
		descriptor === undefined ||
		!fitsKind(descriptor, request)
	) {
		return undefined
	}
	return {
		action: request.action,
		kind,
		field: request.field,
		input: {
			value: request.resource,
			principal: request.principal,
			path: descriptor.path,
		},
		trace,
		predicates: new Map(),
		decisions: new Map(),
	}
}

const decideAny = (
	policy: Any,
	request: AnyRequest,
): Effect.Effect<Decision.Decision, unknown, unknown> =>
	// Each run of the Effect needs its own store of decisions, because the
	// resource value may change between two runs.
	Effect.suspend(() => {
		const context = makeContext(policy.domain, request, undefined)
		return context === undefined
			? Effect.succeed(Decision.NotApplicable)
			: decideNode(nodeOf(policy), context, [])
	})

/**
 * Gives the decision of a policy for a request.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const decide: {
	<D extends Domain.Any = never>(
		request: Request<D>,
	): <E, R, O>(
		policy: Policy<D, E, R, O>,
	) => Effect.Effect<Decision.Decision, E, R>
	<D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O>,
		request: Request<NoInfer<D>>,
	): Effect.Effect<Decision.Decision, E, R>
} = dual(2, decideAny) as never

/**
 * Gives the decision of a policy with no predicates, at once.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const decideSync: {
	<D extends Domain.Any = never>(
		request: Request<D>,
	): (policy: Policy<D>) => Decision.Decision
	<D extends Domain.Any>(
		policy: Policy<D>,
		request: Request<NoInfer<D>>,
	): Decision.Decision
} = dual(2, (policy: Any, request: AnyRequest): Decision.Decision =>
	Effect.runSync(
		// The public type of `decideSync` takes only policies with no
		// predicates, so this Effect has no error and needs no services.
		// @effect-diagnostics-next-line unsafeEffectTypeAssertion:off
		decideAny(policy, request) as Effect.Effect<Decision.Decision>,
	),
)

/**
 * Gives the decision of a policy and the rules that were tested to make it.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const explain: {
	<D extends Domain.Any = never>(
		request: Request<D>,
	): <E, R, O>(policy: Policy<D, E, R, O>) => Effect.Effect<Explanation, E, R>
	<D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O>,
		request: Request<NoInfer<D>>,
	): Effect.Effect<Explanation, E, R>
} = dual(
	2,
	(
		policy: Any,
		request: AnyRequest,
	): Effect.Effect<Explanation, unknown, unknown> =>
		// Each run of the Effect needs its own trace, so the trace is made inside
		// the Effect.
		Effect.gen(function* () {
			const trace = yield* Ref.make<ReadonlyArray<Step>>([])
			const context = makeContext(policy.domain, request, trace)
			if (context === undefined) {
				return { decision: Decision.NotApplicable, steps: [] }
			}
			const decision = yield* decideNode(nodeOf(policy), context, [])
			return { decision, steps: yield* Ref.get(trace) }
		}),
) as never

/**
 * Tests if a deny rule of the request names a part inside `field`.
 */
const deniesInside = (
	node: Node,
	target: { readonly action: string; readonly kind: string },
	field: string,
	// A native set: it must find a node by the node itself. See `remember`.
	seen: Set<Node> = new Set(),
): boolean => {
	// One node may be a child of many nodes. It is tested one time.
	if (seen.has(node)) {
		return false
	}
	seen.add(node)
	switch (node._tag) {
		case "Rules":
			return node.rules.some(
				(value) =>
					value._tag === "Deny" &&
					value.fields !== undefined &&
					value.fields.some((pattern) => Rule.matchesInside(pattern, field)) &&
					(value.actions.includes("*") ||
						value.actions.includes(target.action)) &&
					(value.resources.includes("*") ||
						value.resources.includes(target.kind)),
			)
		case "All":
		case "Any":
		case "FirstOf":
			return node.policies.some((child) =>
				deniesInside(child, target, field, seen),
			)
		case "Ceiling":
			return (
				deniesInside(node.cap, target, field, seen) ||
				deniesInside(node.policy, target, field, seen)
			)
	}
}

/**
 * Gives the fields of a resource value that the policy lets a request use. It
 * tests each field of the resource Schema, with dots for nested fields.
 *
 * A field that holds more than one value, such as a record, is left out when a
 * deny rule names a part of it. The list can not name that part, and the whole
 * field would show it.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const permittedFields: {
	<D extends Domain.Any = never>(
		request: FieldlessRequest<D>,
	): <E, R, O>(
		policy: Policy<D, E, R, O>,
	) => Effect.Effect<ReadonlyArray<string>, E, R>
	<D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O>,
		request: FieldlessRequest<NoInfer<D>>,
	): Effect.Effect<ReadonlyArray<string>, E, R>
} = dual(
	2,
	(
		policy: Any,
		request: Omit<AnyRequest, "field">,
	): Effect.Effect<ReadonlyArray<string>, unknown, unknown> => {
		const kind = Resource.kindOf(request.resource)
		const descriptor: Resource.Descriptor | undefined =
			kind === undefined ? undefined : Domain.descriptorOf(policy.domain, kind)
		if (descriptor === undefined) {
			return Effect.succeed([])
		}
		return Effect.filter(descriptor.fieldPaths, (field) =>
			Effect.map(
				decideAny(policy, { ...request, field }),
				(result) =>
					result._tag === "Allow" &&
					!(
						descriptor.openPaths.includes(field) &&
						deniesInside(
							nodeOf(policy),
							{ ...request, kind: descriptor.kind },
							field,
						)
					),
			),
		)
	},
) as never

// Residual conditions

type Ast = Condition.Ast

/**
 * The two residual conditions of a request. See {@link residuals}.
 *
 * @stability stable
 * @category models
 * @since 0.4.0
 */
export interface Residuals<E = never, R = never, O = never, I = unknown> {
	/** The condition on resource values for which the policy allows. */
	readonly allow: Condition.Condition<E, R, O, I>
	/** The condition on resource values for which the policy denies. */
	readonly deny: Condition.Condition<E, R, O, I>
}

/**
 * A request about a kind of resource, with no types.
 *
 * @stability stable
 * @category models
 * @since 0.4.0
 */
export interface AnyKindRequest {
	readonly principal: object
	readonly action: string
	readonly kind: string
	readonly field?: string | undefined
	/**
	 * A scope needs the types of the domain for its builder. With the request
	 * first, the domain is not known yet, so give the policy first.
	 */
	readonly within?: never
}

/**
 * `unknown` when the request `Req` is a request of the type `T`, and `never`
 * when it is not. With the request first and the policy later, the request is
 * checked when the policy, and so the domain, is known. For a union, each
 * member must be such a request.
 */
type Fits<Req, T> = [Req] extends [T] ? unknown : never

/**
 * What a residual condition reads: a value of the kind `K`. The principal is
 * already in it. A residual is for one kind, so when `K` is a union of kinds,
 * the value must be a value of each of them. No value is, so such a residual
 * can not be evaluated on a value of the wrong kind.
 *
 * @stability stable
 * @category utility types
 * @since 0.4.0
 */
export type ResidualReads<D, K> = Condition.Reads<
	(
		K extends unknown ? (value: Domain.ValueOf<D, K & string>) => void : never
	) extends (value: infer V) => void
		? V
		: never,
	unknown
>

const always: Ast = Condition.always
const never: Ast = Condition.never

/**
 * The most nodes that a residual condition may have. A policy tree may use a
 * condition of a child two times, in its allow condition and in its deny
 * condition, so a small policy may give a very large condition. Past this
 * size, `residual` throws an error.
 */
const maxResidualSize = 10_000

/** A residual condition is too large. See {@link maxResidualSize}. */
class TooLarge {}

/**
 * Makes conditions for one residual, with no types. Each step simplifies the
 * condition, and it stops the work when the condition is too large. The
 * steps keep their work for the parts they have seen, for this residual only.
 */
interface Build {
	readonly and: (...values: ReadonlyArray<Ast>) => Ast
	readonly or: (...values: ReadonlyArray<Ast>) => Ast
	readonly not: (value: Ast) => Ast
}

const makeBuild = (): Build => {
	const simplify = Condition.simplifier()
	const sizes = new Map<Ast, number>()
	/** Gives the number of nodes in a condition, as JSON would have them. */
	const sizeOf = (ast: Ast): number =>
		remember(sizes, ast, () => {
			switch (ast._tag) {
				case "And":
				case "Or":
					return Arr.reduce(
						ast.conditions,
						1,
						(size, child) => size + sizeOf(child),
					)
				case "Not":
					return 1 + sizeOf(ast.condition)
				default:
					return 1
			}
		})
	const limit = (ast: Ast): Ast => {
		if (sizeOf(ast) > maxResidualSize) {
			throw new TooLarge()
		}
		return ast
	}
	// These steps work on nodes with no types, so they leave out the type
	// field of a condition.
	return {
		and: (...values) =>
			limit(simplify(Condition.and(...(values as ReadonlyArray<never>)))),
		or: (...values) =>
			limit(simplify(Condition.or(...(values as ReadonlyArray<never>)))),
		not: (value) => limit(simplify(Condition.not(value as never))),
	}
}

/** The two residual conditions of a node, with no types. */
interface Pair {
	readonly allow: Ast
	readonly deny: Ast
}

interface ResidualContext {
	readonly action: string
	readonly kind: string
	readonly field: string | undefined
	readonly input: {
		readonly principal: object
		readonly path: Condition.Input["path"]
	}
	/**
	 * The work done on each node. One node may be a child of many nodes, so
	 * the work on it is done only one time.
	 */
	readonly pairs: Map<Node, Pair>
	readonly predicates: Map<Node, boolean>
	readonly build: Build
}

const ruleCondition = (value: Rule.Any, context: ResidualContext): Ast =>
	!Rule.matchesTarget(value, context)
		? never
		: value.when === undefined
			? always
			: Condition.partial(value.when as Condition.Any, context.input)

/**
 * Gives the conditions for "the first rule that applies is an allow rule" and
 * "the first rule that applies is a deny rule".
 */
const firstApplicableResidual = (
	values: ReadonlyArray<Rule.Any>,
	context: ResidualContext,
): Pair => {
	const { and, not, or } = context.build
	// The rules go in runs of one tag, from the last run to the first. The
	// conditions of a run go into one node at once. With one node for each
	// rule, each step would flatten the whole condition again.
	const runs = Arr.isReadonlyArrayNonEmpty(values)
		? Arr.groupWith(values, (a, b) => a._tag === b._tag)
		: []
	return Arr.reduceRight(
		runs,
		{ allow: never, deny: never },
		(rest: Pair, run): Pair => {
			const applies = or(
				...Arr.map(run, (value) => ruleCondition(value, context)),
			)
			return run[0]._tag === "Allow"
				? { allow: or(applies, rest.allow), deny: and(not(applies), rest.deny) }
				: { allow: and(not(applies), rest.allow), deny: or(applies, rest.deny) }
		},
	)
}

const residualNode = (node: Node, context: ResidualContext): Pair =>
	remember(context.pairs, node, () => residualOnce(node, context))

const residualOnce = (node: Node, context: ResidualContext): Pair => {
	const { and, not, or } = context.build
	switch (node._tag) {
		case "Rules": {
			switch (node.algorithm) {
				case "denyOverrides": {
					const deny = or(
						...node.rules
							.filter((value) => value._tag === "Deny")
							.map((value) => ruleCondition(value, context)),
					)
					const allow = and(
						not(deny),
						or(
							...node.rules
								.filter((value) => value._tag === "Allow")
								.map((value) => ruleCondition(value, context)),
						),
					)
					return { allow, deny }
				}
				case "permitOverrides": {
					const allow = or(
						...node.rules
							.filter((value) => value._tag === "Allow")
							.map((value) => ruleCondition(value, context)),
					)
					const deny = and(
						not(allow),
						or(
							...node.rules
								.filter((value) => value._tag === "Deny")
								.map((value) => ruleCondition(value, context)),
						),
					)
					return { allow, deny }
				}
				case "firstApplicable":
					return firstApplicableResidual(node.rules, context)
				case "lastApplicable":
					return firstApplicableResidual(node.rules.slice().reverse(), context)
			}
		}
		// falls through: every algorithm returns above
		case "All": {
			if (node.policies.length === 0) {
				return { allow: never, deny: never }
			}
			const pairs = node.policies.map((child) => residualNode(child, context))
			const deny = or(...pairs.map((pair) => pair.deny))
			const allow = and(...pairs.map((pair) => pair.allow), not(deny))
			return { allow, deny }
		}
		case "Any": {
			const pairs = node.policies.map((child) => residualNode(child, context))
			const allow = or(...pairs.map((pair) => pair.allow))
			const deny = and(not(allow), or(...pairs.map((pair) => pair.deny)))
			return { allow, deny }
		}
		case "FirstOf": {
			// The first child that gives an answer wins.
			return Arr.reduceRight(
				node.policies,
				{ allow: never, deny: never },
				(rest: Pair, child): Pair => {
					const pair = residualNode(child, context)
					return {
						allow: or(pair.allow, and(not(pair.deny), rest.allow)),
						deny: or(pair.deny, and(not(pair.allow), rest.deny)),
					}
				},
			)
		}
		case "Ceiling": {
			const cap = residualNode(node.cap, context)
			const inner = residualNode(node.policy, context)
			return {
				allow: and(not(cap.deny), inner.allow),
				deny: or(cap.deny, inner.deny),
			}
		}
	}
}

/** The name of the predicate of a residual condition that runs `decide`. */
const policyPredicate = "policy"

/** Tests if a rule of a policy tree has a predicate. */
const nodeHasPredicate = (
	node: Node,
	memo: Map<Node, boolean> = new Map(),
): boolean =>
	remember(memo, node, () => {
		const test = (child: Node) => nodeHasPredicate(child, memo)
		switch (node._tag) {
			case "Rules":
				return Arr.some(
					node.rules,
					(value) =>
						value.when !== undefined && Condition.hasPredicate(value.when),
				)
			case "All":
			case "Any":
			case "FirstOf":
				return Arr.some(node.policies, test)
			case "Ceiling":
				return test(node.cap) || test(node.policy)
		}
	})

/** Tests if a rule that the request may use has a predicate. */
const usesPredicate = (node: Node, context: ResidualContext): boolean =>
	remember(context.predicates, node, () => usesPredicateOnce(node, context))

const usesPredicateOnce = (node: Node, context: ResidualContext): boolean => {
	switch (node._tag) {
		case "Rules":
			return node.rules.some(
				(value) =>
					value.when !== undefined &&
					Condition.hasPredicate(value.when) &&
					Rule.matchesTarget(value, context),
			)
		case "All":
		case "Any":
		case "FirstOf":
			return node.policies.some((child) => usesPredicate(child, context))
		case "Ceiling":
			return (
				usesPredicate(node.cap, context) || usesPredicate(node.policy, context)
			)
	}
}

const isScopeValue = (operand: Condition.Operand): boolean =>
	operand._tag === "Principal" ||
	operand.value === null ||
	typeof operand.value === "string" ||
	typeof operand.value === "number" ||
	typeof operand.value === "boolean"

/**
 * Gives the problem of a scope that is not plain data, or `undefined` when it
 * is plain data. A predicate, or a value that a condition can not hold, such
 * as `undefined` from a route parameter, is a defect: such a scope could make
 * a check pass on the wrong values. A shared node is tested one time.
 */
const scopeProblem = (
	ast: Ast,
	memo: Map<Ast, string | null> = new Map(),
): string | undefined =>
	remember(memo, ast, (): string | null => {
		switch (ast._tag) {
			case "Predicate":
				return "can not have a predicate"
			case "Compare":
				return isScopeValue(ast.value)
					? null
					: `has a value for "${ast.field}" that is not a scalar`
			case "In":
				return Arr.every(ast.values, isScopeValue)
					? null
					: `has a value for "${ast.field}" that is not a scalar`
			case "Under":
				return Arr.every(ast.prefix, isScopeValue)
					? null
					: "has a path part that is not a scalar"
			case "And":
			case "Or":
				return (
					Option.getOrNull(
						Arr.findFirst(
							Arr.map(ast.conditions, (child) => scopeProblem(child, memo)),
							(problem) => problem !== undefined,
						),
					) ?? null
				)
			case "Not":
				return scopeProblem(ast.condition, memo) ?? null
			default:
				return null
		}
	}) ?? undefined

/**
 * Gives the condition of a scope, with the principal and the path in it.
 * With no scope, it is `True`.
 */
const scopeOf = (within: unknown, input: ResidualContext["input"]): Ast => {
	if (within === undefined) {
		return always
	}
	const ast = (within as (builder: unknown) => Ast)(Condition.builder())
	const problem = scopeProblem(ast)
	if (problem !== undefined) {
		throw new globalThis.Error(`A scope ${problem}`)
	}
	return Condition.partial(ast as Condition.Condition, input)
}

/** A request about a kind with no types, with the scope of a target. */
interface ScopedRequest {
	readonly principal: object
	readonly action: string
	readonly kind: string
	readonly field?: string | undefined
	readonly within?: unknown
}

/** The scope of a request, and the residual conditions inside it. */
interface Scoped extends Pair {
	readonly scope: Ast
	readonly schema: Schema.Top | undefined
}

const residualsAny = (policy: Any, request: ScopedRequest): Pair =>
	scopedResiduals(policy, request)

const scopedResiduals = (policy: Any, request: ScopedRequest): Scoped => {
	const descriptor = Domain.descriptorOf(policy.domain, request.kind)
	if (descriptor === undefined || !fitsKind(descriptor, request)) {
		return { scope: never, allow: never, deny: never, schema: undefined }
	}
	const input = { principal: request.principal, path: descriptor.path }
	const scope = scopeOf(request.within, input)
	const build = makeBuild()
	const and = build.and
	const inScope = (pair: Pair): Scoped => ({
		scope,
		allow: and(scope, pair.allow),
		deny: and(scope, pair.deny),
		schema: descriptor.schema,
	})
	if (scope._tag === "False") {
		return inScope({ allow: never, deny: never })
	}
	const context: ResidualContext = {
		action: request.action,
		kind: request.kind,
		field: request.field,
		input,
		pairs: new Map(),
		predicates: new Map(),
		build,
	}
	if (!usesPredicate(nodeOf(policy), context)) {
		try {
			return inScope(residualNode(nodeOf(policy), context))
		} catch (error) {
			// The type of the residual of a plain policy says that it has no
			// predicate, so it can not be the predicate below. The policy is too
			// large for a residual, and that is a defect.
			if (error instanceof TooLarge) {
				throw new globalThis.Error(
					`The residual condition of this request would have more than ${String(maxResidualSize)} nodes`,
				)
			}
			throw error
		}
	}
	// A predicate may fail, and it may give another answer each time it runs.
	// A tree of `And` and `Or` nodes can not run the predicates in the same
	// order and the same number of times as `decide`. So the residual is one
	// predicate that runs `decide` for each value.
	const decision = (value: object) =>
		decideNode(
			policy.node,
			{
				action: request.action,
				kind: request.kind,
				field: request.field,
				input: {
					value,
					principal: request.principal,
					path: descriptor.path,
				},
				trace: undefined,
				predicates: new Map(),
				decisions: new Map(),
			},
			[],
		)
	// A value of another kind is not a value that the residual is about, so
	// the rules of this kind must not run on it.
	const test = (tag: Decision.Decision["_tag"]): Ast =>
		Condition.builder<any, any, any>().predicate(policyPredicate, (value) =>
			Resource.kindOf(value) === request.kind
				? Effect.map(decision(value), (result) => result._tag === tag)
				: Effect.succeed(false),
		)
	// The scope comes first in each `And`, so the policy runs only on values
	// in the scope.
	return inScope({ allow: test("Allow"), deny: test("Deny") })
}

/**
 * Gives the condition on resource values for which the policy allows a
 * request. It has no principal fields and no `Under` nodes, so you can give it
 * to `Condition.fold`. It is `True` when the policy allows every value of the
 * kind, and `False` when it allows none.
 *
 * With a scope (`within`), the condition is the scope and the residual
 * together, so it is false for every value outside the scope. Give the policy
 * first to use a scope. The condition comes from its parts, with no search. To
 * know if it allows all of the scope or none of it, use {@link coverage}.
 *
 * When a rule that the request may use has a predicate, the condition is one
 * predicate with the name `"policy"`. It runs the whole policy for each value,
 * so its answers and its failures are the same as those of {@link decide}. It
 * takes the principal with it. Give it resource values with their `_tag`. It
 * is false for a value of another kind.
 *
 * A policy tree may use the condition of a child two times, so a small policy
 * may give a very large condition. When the condition would have more than
 * 10000 nodes, this function throws an error. In an `Authorizer`, the error is
 * a defect, so the check fails.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const residual: {
	<const Req extends AnyKindRequest>(
		request: Req,
	): <D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O> & Fits<Req, KindRequest<D>>,
	) => Condition.Condition<E, R, O, ResidualReads<D, Req["kind"]>>
	<D extends Domain.Any, E, R, O, const Req extends KindRequest<NoInfer<D>>>(
		policy: Policy<D, E, R, O>,
		request: Req,
	): Condition.Condition<E, R, O, ResidualReads<D, Req["kind"]>>
} = dual(
	2,
	(policy: Any, request: KindRequest<Domain.Any>): Ast =>
		residualsAny(policy, request).allow,
) as never

/**
 * Gives both residual conditions of a request: the values that the policy
 * allows, and the values that it denies. A value in neither is not
 * applicable. See {@link residual}.
 *
 * @stability stable
 * @category evaluation
 * @since 0.4.0
 */
export const residuals: {
	<const Req extends AnyKindRequest>(
		request: Req,
	): <D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O> & Fits<Req, KindRequest<D>>,
	) => Residuals<E, R, O, ResidualReads<D, Req["kind"]>>
	<D extends Domain.Any, E, R, O, const Req extends KindRequest<NoInfer<D>>>(
		policy: Policy<D, E, R, O>,
		request: Req,
	): Residuals<E, R, O, ResidualReads<D, Req["kind"]>>
} = dual(2, residualsAny) as never

/**
 * How much of a scope a policy allows. In each case, `condition` is the exact
 * condition on the values in the scope that the policy allows: give it to
 * `Condition.fold` for a list query.
 * - `All`: the policy allows every value in the scope. `condition` is the
 *   scope (`True` with no scope).
 * - `None`: the policy allows no value in the scope. `condition` is `False`.
 *   An empty scope is `None` too, so a check on a scope that has a mistake,
 *   such as a principal field with no value, never passes.
 * - `Some`: the policy allows some values in the scope and not others.
 *   `allowed` is an example of a value that it allows, and `refused` of a
 *   value in the scope that it does not allow.
 * - `Unknown`: the answer needs a predicate, or the search went past its
 *   budget.
 *
 * @stability stable
 * @category models
 * @since 0.5.0
 */
export type Coverage<
	E = never,
	R = never,
	O = never,
	I = unknown,
> = Data.TaggedEnum<{
	All: { readonly condition: Condition.Condition<E, R, O, I> }
	None: { readonly condition: Condition.Condition<E, R, O, I> }
	Some: {
		readonly condition: Condition.Condition<E, R, O, I>
		readonly allowed: Condition.Example
		readonly refused: Condition.Example
	}
	Unknown: {
		readonly condition: Condition.Condition<E, R, O, I>
		readonly reason: "predicate" | "budget"
	}
}>

/** A {@link Coverage} with no types. */
type AnyCoverage = Data.TaggedEnum<{
	All: { readonly condition: Ast }
	None: { readonly condition: Ast }
	Some: {
		readonly condition: Ast
		readonly allowed: Condition.Example
		readonly refused: Condition.Example
	}
	Unknown: {
		readonly condition: Ast
		readonly reason: "predicate" | "budget"
	}
}>

const coverages = Data.taggedEnum<AnyCoverage>()

const coverageAny = (policy: Any, request: ScopedRequest): AnyCoverage => {
	const scoped = scopedResiduals(policy, request)
	const allowed = scoped.allow
	const options = { schema: scoped.schema }
	const some =
		allowed._tag === "False"
			? undefined
			: Condition.satisfiable(allowed as Condition.Condition, options)
	if (some === undefined || some._tag === "Unsatisfiable") {
		return coverages.None({ condition: never })
	}
	if (some._tag === "Unknown") {
		return coverages.Unknown({ condition: allowed, reason: some.reason })
	}
	// Only two nodes more than `allowed`, so it needs no size limit.
	const refused: Ast = Condition.simplify(
		Condition.and(
			scoped.scope as Condition.Condition,
			Condition.not(allowed as Condition.Condition),
		),
	)
	const missing =
		refused._tag === "False"
			? undefined
			: Condition.satisfiable(refused as Condition.Condition, options)
	if (missing === undefined || missing._tag === "Unsatisfiable") {
		return coverages.All({ condition: scoped.scope })
	}
	if (missing._tag === "Unknown") {
		return coverages.Unknown({ condition: allowed, reason: missing.reason })
	}
	return coverages.Some({
		condition: allowed,
		allowed: some.example,
		refused: missing.example,
	})
}

/**
 * Tells how much of a scope the policy allows: all of it, none of it, or some
 * of it. See {@link Coverage}. With no scope (`within`), the scope is every
 * value of the kind.
 *
 * The answer comes from {@link Condition.satisfiable} with the Schema of the
 * resource, so it is exact for the values of the Schema. Schema checks other
 * than finite and integer checks are left out, so `All` may be missed where
 * such a check stops the other values, but `All` is never given wrongly.
 *
 * `Some` means that some value of the Schema is allowed. It does not mean that
 * such a value is in your database. To know that, run `condition` as a query.
 *
 * @stability stable
 * @category evaluation
 * @since 0.5.0
 */
export const coverage: {
	<const Req extends AnyKindRequest>(
		request: Req,
	): <D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O> & Fits<Req, KindRequest<D>>,
	) => Coverage<E, R, O, ResidualReads<D, Req["kind"]>>
	<D extends Domain.Any, E, R, O, const Req extends KindRequest<NoInfer<D>>>(
		policy: Policy<D, E, R, O>,
		request: Req,
	): Coverage<E, R, O, ResidualReads<D, Req["kind"]>>
} = dual(2, coverageAny) as never

// Schema

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

const AlgorithmSchema = Schema.Literals([
	"denyOverrides",
	"permitOverrides",
	"firstApplicable",
	"lastApplicable",
])

const encodedRuleSchema = (meta: Schema.Top | undefined) =>
	Schema.Struct({
		_tag: Schema.Literals(["Allow", "Deny"]),
		actions: Schema.Array(Schema.String),
		resources: Schema.Array(Schema.String),
		when: Schema.optionalKey(Condition.schema),
		fields: Schema.String.pipe(Schema.Array, Schema.optionalKey),
		reason: Schema.optionalKey(Schema.String),
		id: Schema.optionalKey(Schema.String),
		meta: Schema.optionalKey(
			(meta ?? Schema.Never) as Schema.Codec<unknown, unknown>,
		),
	})

const encodedNodeSchema = (
	meta: Schema.Top | undefined,
): Schema.Codec<EncodedNode> => {
	const self: Schema.Codec<EncodedNode> = Schema.Union([
		Schema.TaggedStruct("Rules", {
			algorithm: AlgorithmSchema,
			rules: Schema.Array(encodedRuleSchema(meta)),
		}),
		Schema.TaggedStruct("All", {
			policies: Schema.Array(Schema.suspend(() => self)),
		}),
		Schema.TaggedStruct("Any", {
			policies: Schema.Array(Schema.suspend(() => self)),
		}),
		Schema.TaggedStruct("FirstOf", {
			policies: Schema.Array(Schema.suspend(() => self)),
		}),
		Schema.TaggedStruct("Ceiling", {
			cap: Schema.suspend(() => self),
			policy: Schema.suspend(() => self),
		}),
	]) as never
	return self
}

type ConditionNode = Condition.Encoded | Ast

const principalRefs = (ast: ConditionNode): ReadonlyArray<string> =>
	Array.from(refsIn(ast, new Map()))

/** The principal fields of a node. A shared node is visited one time. */
const refsIn = (
	node: ConditionNode,
	memo: Map<ConditionNode, HashSet.HashSet<string>>,
): HashSet.HashSet<string> =>
	remember(memo, node, () => {
		const refs = (operands: ReadonlyArray<Condition.Operand>) =>
			HashSet.fromIterable(
				Arr.flatMap(operands, (operand) =>
					operand._tag === "Principal" ? [operand.path] : [],
				),
			)
		switch (node._tag) {
			case "Compare":
				return refs([node.value])
			case "In":
				return refs(node.values)
			case "Under":
				return refs(node.prefix)
			case "And":
			case "Or":
				return Arr.reduce(
					node.conditions as ReadonlyArray<ConditionNode>,
					HashSet.empty<string>(),
					(all, child) => HashSet.union(all, refsIn(child, memo)),
				)
			case "Not":
				return refsIn(node.condition, memo)
			default:
				return HashSet.empty()
		}
	})

interface Issue {
	readonly path: ReadonlyArray<PropertyKey>
	readonly issue: string
}

/**
 * Checks the names in an encoded policy against the domain. It gives one
 * message for each problem.
 */
const validate = (
	domain: Domain.Any,
	root: EncodedNode,
): ReadonlyArray<Issue> => {
	const principalPaths = domain.principal.pipe(
		Resource.fieldPaths,
		HashSet.fromIterable,
	)
	const ruleIssues = (
		value: EncodedRule,
		at: ReadonlyArray<PropertyKey>,
	): ReadonlyArray<Issue> => {
		const all = value.resources.includes("*")
		const named = Arr.filter(value.resources, (kind) => kind !== "*")
		const descriptors = Arr.flatMap(named, (kind) => {
			const descriptor = Domain.descriptorOf(domain, kind)
			return descriptor === undefined ? [] : [descriptor]
		})
		const known = all
			? Array.from(HashMap.values(domain.resources))
			: descriptors
		const usedFields = [
			...Arr.filter(value.fields ?? [], (field) => !field.includes("*")),
			...(value.when === undefined ? [] : Condition.fields(value.when as Ast)),
		]
		return [
			...Arr.map(
				Arr.filter(named, (kind) => !HashMap.has(domain.resources, kind)),
				(kind): Issue => ({
					path: [...at, "resources"],
					issue: `There is no resource with the kind "${kind}"`,
				}),
			),
			...Arr.map(
				Arr.filter(
					value.actions,
					(action) =>
						action !== "*" &&
						!Arr.some(known, (descriptor) =>
							descriptor.actions.includes(action),
						),
				),
				(action): Issue => ({
					path: [...at, "actions"],
					issue: `The action "${action}" is not an action of these resources`,
				}),
			),
			...Arr.map(
				Arr.filter(
					usedFields,
					(field) =>
						all ||
						descriptors.length === 0 ||
						!Arr.every(
							descriptors,
							(descriptor) =>
								descriptor.fieldPaths.includes(field) ||
								// A key of a record, or a field deep in a recursive
								// Schema.
								Resource.hasPath(descriptor.schema, field),
						),
				),
				(field): Issue => ({
					path: at,
					issue: `The field "${field}" is not a field of every resource of the rule`,
				}),
			),
			...Arr.map(
				Arr.filter(
					value.when === undefined ? [] : principalRefs(value.when),
					(ref) =>
						!HashSet.has(principalPaths, ref) &&
						!Resource.hasPath(domain.principal, ref),
				),
				(ref): Issue => ({
					path: [...at, "when"],
					issue: `The principal has no field "${ref}"`,
				}),
			),
		]
	}
	const issuesOf = (
		node: EncodedNode,
		path: ReadonlyArray<PropertyKey>,
	): ReadonlyArray<Issue> => {
		switch (node._tag) {
			case "Rules":
				return Arr.flatMap(node.rules, (value, index) =>
					ruleIssues(value, [...path, "rules", index]),
				)
			case "All":
			case "Any":
			case "FirstOf":
				return Arr.flatMap(node.policies, (child, index) =>
					issuesOf(child, [...path, "policies", index]),
				)
			case "Ceiling":
				return [
					...issuesOf(node.cap, [...path, "cap"]),
					...issuesOf(node.policy, [...path, "policy"]),
				]
		}
	}
	return issuesOf(root, [])
}

/**
 * Makes a policy tree from its JSON form. Each rule gets the domain of the
 * Schema, as a rule from the builder of the domain has it.
 */
const decodeNode = (node: EncodedNode, domain: Domain.Any): Node => {
	switch (node._tag) {
		case "Rules":
			return nodes.Rules({
				algorithm: node.algorithm,
				rules: node.rules.map((value) =>
					Rule.make({ ...(value as Rule.Shape), domain }),
				),
			})
		case "All":
		case "Any":
		case "FirstOf":
			return nodes[node._tag]({
				policies: node.policies.map((child) => decodeNode(child, domain)),
			})
		case "Ceiling":
			return nodes.Ceiling({
				cap: decodeNode(node.cap, domain),
				policy: decodeNode(node.policy, domain),
			})
	}
}

/**
 * Tests if a value is a policy.
 *
 * @stability stable
 * @category guards
 * @since 0.3.0
 */
export const isPolicy = (u: unknown): u is Any => u instanceof PolicyData

/**
 * The Schema of the policies of a domain with no predicates. Decoding checks
 * every kind, action, field and principal field against the domain, and the
 * `meta` of each rule against the `meta` Schema of the domain.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export const schema = <D extends Domain.Any>(
	domain: D,
): Schema.Codec<Policy<D>, EncodedNode> =>
	encodedNodeSchema(domain.meta).pipe(
		Schema.check(Schema.makeFilter((node) => validate(domain, node))),
		Schema.decodeTo(
			// A policy with a predicate is not a plain policy, and it can not
			// become JSON.
			Schema.declare(
				(u): u is Policy<D> =>
					isPolicy(u) && u.domain === domain && !nodeHasPredicate(u.node),
			),
			SchemaTransformation.transform({
				decode: (node: EncodedNode) =>
					fromNode(domain, decodeNode(node, domain)),
				encode: (policy: Policy<D>) => encodeNode(policy.node),
			}),
		),
	)
