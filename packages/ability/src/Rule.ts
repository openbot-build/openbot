/**
 * A rule says that a principal may (`Allow`) or may not (`Deny`) do some
 * actions on some resources. A rule may have:
 * - a condition, which must be true for the rule to apply;
 * - a list of fields, for rules about parts of a resource;
 * - a reason, an id, and extra data (`meta`).
 *
 * Rules do not change, and two rules with the same data are equal. A rule
 * works in a generator, so you can write `yield* _.allow(...)` inside
 * `Policy.define`.
 *
 * The action `"*"` means every action. The resource `"*"` means every
 * resource.
 *
 * Field names in a rule may have patterns. `*` stands for any part of one
 * field name, and `**` stands for any number of parts. So `address.*` covers
 * `address.city`, and `**` covers every field.
 *
 * @stability stable
 * @since 0.3.0
 */
import * as Arr from "effect/Array"
import * as Data from "effect/Data"
import * as HashSet from "effect/HashSet"
import type * as Pipeable from "effect/Pipeable"
import * as Condition from "./Condition.ts"
import type * as Domain from "./Domain.ts"
import * as Resource from "./Resource.ts"

/**
 * A rule. `E`, `R` and `O` come from its condition. See
 * `Condition.Condition`. `D` is the domain of the rule. A predicate reads the
 * values and the principal of its domain, so a rule may go only into a policy
 * of its own domain. A rule from {@link make} has the domain `any`. `I` is
 * what the predicates of its condition read. See `Condition.Reads`.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Rule<E = never, R = never, O = never, D = any, I = unknown>
	extends Shape<E, R, O, I>, Pipeable.Pipeable {
	readonly "~Rule"?: Condition.Variance<E, R, O>
	readonly "~Domain"?: (domain: D) => D
	[Symbol.iterator](): Generator<
		Rule<E, R, O, D, I>,
		Rule<E, R, O, D, I>,
		unknown
	>
}

/**
 * The data of a rule.
 *
 * @stability stable
 * @category models
 * @since 0.4.0
 */
export interface Shape<E = never, R = never, O = never, I = unknown> {
	readonly _tag: "Allow" | "Deny"
	readonly actions: ReadonlyArray<string>
	readonly resources: ReadonlyArray<string>
	readonly when?: Condition.Condition<E, R, O, I>
	readonly fields?: ReadonlyArray<string>
	readonly reason?: string
	readonly id?: string
	readonly meta?: unknown
	/**
	 * The domain of the builder that made the rule. Two domains may have the
	 * same types but other paths, so the types can not tell them apart. It is
	 * not in the JSON form of a rule.
	 */
	readonly domain?: Domain.Any
}

/**
 * Any rule.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
// Every rule fits `never` as what it reads, and a condition taken from such a
// rule fits no rule that reads a value or a principal.
export type Any = Rule<any, any, any, any, never>

/**
 * The error type of a rule.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Error<A> = A extends {
	readonly "~Rule"?: Condition.Variance<infer E, infer _R, infer _O>
}
	? E
	: never

/**
 * The service type of a rule.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Services<A> = A extends {
	readonly "~Rule"?: Condition.Variance<infer _E, infer R, infer _O>
}
	? R
	: never

/**
 * `Condition.Opaque` when a rule has a predicate.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type OpaqueOf<A> = A extends {
	readonly "~Rule"?: Condition.Variance<infer _E, infer _R, infer O>
}
	? O
	: never

/**
 * A resource in a rule: a kind name, a resource of the domain, or `"*"`.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Target<D> = Domain.Kind<D> | Domain.Resources<D> | "*"

/**
 * The kind name of a target.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type KindOf<T> = T extends string ? T : Resource.Kind<T>

/**
 * The actions that a rule may use for the kinds `K`.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type ActionFor<D, K> =
	| "*"
	| ("*" extends K
			? Domain.AnyAction<D>
			: Domain.ActionOf<D, Extract<K, string>>)

/**
 * The targets in the resource argument of a rule: the one target, or the
 * targets of a list.
 *
 * @stability stable
 * @category utility types
 * @since 0.4.0
 */
export type TargetOf<Res> = [Res] extends [ReadonlyArray<infer X>] ? X : Res

/**
 * The actions that a rule may use for its resource argument. A list of
 * resources may use an action of any of them. One target with a union type
 * may use only an action of every kind in the union, because its value may be
 * any one of them.
 *
 * @stability stable
 * @category utility types
 * @since 0.4.0
 */
export type ActionForTargets<D, Res> = [Res] extends [ReadonlyArray<infer X>]
	? ActionFor<D, KindOf<X>>
	: | "*"
		| ("*" extends KindOf<Res>
				? Domain.AnyAction<D>
				: Domain.CommonAction<D, Extract<KindOf<Res>, string>>)

/**
 * The data type of the kinds `K`. For `"*"` it has no fields.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type DataFor<D, K> = "*" extends K
	? {}
	: Domain.DataOf<D, Extract<K, string>>

/**
 * The value type of the kinds `K`.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type ValueFor<D, K> = "*" extends K
	? Domain.AnyValue<D>
	: Domain.ValueOf<D, Extract<K, string>>

/**
 * A field name or a field pattern of the kinds `K`.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type FieldFor<D, K> =
	Condition.FieldSelector<DataFor<D, K>> | `${string}*${string}`

/**
 * A condition that a rule for the kinds `K` may have. Its predicates may read
 * only the values of these kinds and the principal of the domain.
 *
 * @stability stable
 * @category models
 * @since 0.4.0
 */
export type ConditionFor<D, K> = Condition.Condition<
	any,
	any,
	any,
	Condition.Reads<ValueFor<D, K>, Domain.Principal<D>>
>

/**
 * The options of a rule.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Options<D, K, C extends Condition.Any> {
	/** The condition. It gets a builder with the types of the resource. */
	readonly when?: (
		builder: Condition.Builder<
			DataFor<D, K>,
			ValueFor<D, K>,
			Domain.Principal<D>
		>,
	) => C
	readonly fields?: ReadonlyArray<FieldFor<D, K>>
	readonly reason?: string
	readonly id?: string
	readonly meta?: Domain.Meta<D>
}

type SingleOrArray<A> = A | ReadonlyArray<A>

/**
 * Makes rules with the types of a domain.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Builder<D> {
	readonly allow: <
		const Res extends SingleOrArray<Target<D>>,
		const A extends ActionForTargets<D, Res>,
		const C extends ConditionFor<D, KindOf<TargetOf<Res>>> =
			Condition.Condition,
	>(
		action: SingleOrArray<A>,
		resource: Res,
		options?: Options<D, KindOf<TargetOf<Res>>, C>,
	) => Rule<
		Condition.Error<C>,
		Condition.Services<C>,
		Condition.OpaqueOf<C>,
		D,
		Condition.ReadsOf<C>
	>
	readonly deny: <
		const Res extends SingleOrArray<Target<D>>,
		const A extends ActionForTargets<D, Res>,
		const C extends ConditionFor<D, KindOf<TargetOf<Res>>> =
			Condition.Condition,
	>(
		action: SingleOrArray<A>,
		resource: Res,
		options?: Options<D, KindOf<TargetOf<Res>>, C>,
	) => Rule<
		Condition.Error<C>,
		Condition.Services<C>,
		Condition.OpaqueOf<C>,
		D,
		Condition.ReadsOf<C>
	>
}

/**
 * The class of every rule value. A rule works in a generator: it gives
 * itself, so `yield* _.allow(...)` gives the rule to `Policy.define`.
 */
class RuleData extends Data.Class<Shape<unknown, unknown, unknown, any>> {
	*[Symbol.iterator](): Generator<this, this, unknown> {
		yield this
		return this
	}
}

/**
 * Makes a rule from its data. It does not check the data against a domain.
 * Use {@link builder} for rules with types, or `Policy.schema` for rules from
 * JSON.
 *
 * @stability stable
 * @category constructors
 * @since 0.4.0
 */
export const make = <E = never, R = never, O = never, I = unknown>(
	data: Shape<E, R, O, I>,
): Rule<E, R, O, any, I> => {
	// A missing option is left out, so two rules with the same data are equal.
	const shape: Shape<E, R, O, I> = {
		_tag: data._tag,
		actions: [...data.actions],
		resources: [...data.resources],
		...(data.when === undefined ? {} : { when: data.when }),
		...(data.fields === undefined ? {} : { fields: [...data.fields] }),
		...(data.reason === undefined ? {} : { reason: data.reason }),
		...(data.id === undefined ? {} : { id: data.id }),
		...(data.meta === undefined ? {} : { meta: data.meta }),
		...(data.domain === undefined ? {} : { domain: data.domain }),
	}
	return new RuleData(shape) as never
}

const toArray = <A>(value: A | ReadonlyArray<A>): ReadonlyArray<A> =>
	Array.isArray(value) ? value : [value as A]

const kindName = (target: unknown): string =>
	Resource.isResource(target)
		? Resource.descriptor(target).kind
		: (target as string)

/**
 * Gives the domain of the builder that made a rule. A rule from {@link make}
 * has none, unless its data gives one.
 *
 * @stability stable
 * @category getters
 * @since 0.4.0
 */
export const domainOf = (rule: Any): Domain.Any | undefined => rule.domain

const makeFromOptions =
	(tag: "Allow" | "Deny", domain: Domain.Any) =>
	(
		action: string | ReadonlyArray<string>,
		resource: unknown,
		options?: {
			readonly when?: (builder: never) => Condition.Any
			readonly fields?: ReadonlyArray<string>
			readonly reason?: string
			readonly id?: string
			readonly meta?: unknown
		},
	): Any =>
		make({
			_tag: tag,
			actions: toArray(action),
			resources: Arr.map(toArray(resource), kindName),
			...(options?.when === undefined
				? {}
				: { when: options.when(Condition.builder() as never) }),
			...(options?.fields === undefined ? {} : { fields: options.fields }),
			...(options?.reason === undefined ? {} : { reason: options.reason }),
			...(options?.id === undefined ? {} : { id: options.id }),
			...(options?.meta === undefined ? {} : { meta: options.meta }),
			domain,
		})

/**
 * Makes a rule builder for a domain.
 *
 * @example
 * ```ts
 * const _ = Rule.builder(App)
 * const rule = _.allow("read", Bot, {
 *   when: ($) => $.eq("ownerUserId", $.principal("userId")),
 * })
 * ```
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const builder = <D extends Domain.Any>(domain: D): Builder<D> =>
	({
		allow: makeFromOptions("Allow", domain),
		deny: makeFromOptions("Deny", domain),
	}) as never

/**
 * Tests if a value is a rule.
 *
 * @stability stable
 * @category guards
 * @since 0.3.0
 */
export const isRule = (u: unknown): u is Any => u instanceof RuleData

/**
 * A part of a field pattern: `"**"`, `"*"`, or one plain Unicode code point.
 */
type Token = string

/**
 * Gives the parts of a pattern. It reads the pattern by Unicode code points,
 * as `run` reads the field. One star is `*`. Two or more stars next to each
 * other match what `**` matches, so they are one part, `**`. So two star parts
 * are never next to each other.
 */
const tokensOf = (pattern: string): ReadonlyArray<Token> =>
	Arr.map(pattern.match(/\*+|[^*]/gu) ?? [], (part) =>
		part.startsWith("*") ? (part.length === 1 ? "*" : "**") : part,
	)

const isStar = (token: Token | undefined): boolean =>
	token === "*" || token === "**"

type States = HashSet.HashSet<number>

/** Adds the places after the stars, because a star may match nothing. */
const close = (tokens: ReadonlyArray<Token>, states: States): States => {
	const after = HashSet.map(
		HashSet.filter(
			states,
			(state) => isStar(tokens[state]) && !HashSet.has(states, state + 1),
		),
		(state) => state + 1,
	)
	return HashSet.size(after) === 0
		? states
		: close(tokens, HashSet.union(states, after))
}

/** Gives the places in the pattern after one more character of the input. */
const step = (
	tokens: ReadonlyArray<Token>,
	states: States,
	char: string,
): States =>
	close(
		tokens,
		HashSet.fromIterable(
			Arr.flatMap(Array.from(states), (state) => {
				const token = tokens[state]
				return token === "**" || (token === "*" && char !== ".")
					? [state]
					: token === char
						? [state + 1]
						: []
			}),
		),
	)

/**
 * Gives every place in the pattern that a match may have reached after
 * `input`. It keeps a set of places, and it does not go back, so the time is
 * at most the length of the input times the length of the pattern. A regular
 * expression may take a very long time on a pattern with many stars.
 */
const run = (tokens: ReadonlyArray<Token>, input: string): States =>
	Arr.reduce(
		Array.from(input),
		close(tokens, HashSet.make(0)),
		(states, char) =>
			HashSet.size(states) === 0 ? states : step(tokens, states, char),
	)

/**
 * Tests if a field name matches a field name or a field pattern of a rule.
 *
 * @stability stable
 * @category predicates
 * @since 0.3.0
 */
export const matchesField = (pattern: string, field: string): boolean => {
	if (!pattern.includes("*")) {
		return pattern === field
	}
	const tokens = tokensOf(pattern)
	return HashSet.has(run(tokens, field), tokens.length)
}

/**
 * Tests if a field pattern may match a field inside `field`, such as
 * `settings.secret` inside `settings`, or `settings.` for the empty key of a
 * record.
 *
 * @stability stable
 * @category predicates
 * @since 0.4.0
 */
export const matchesInside = (pattern: string, field: string): boolean =>
	// The name of a part may be empty, as a key of a record may be. So a match
	// that ends just after the dot names a part too.
	HashSet.size(run(tokensOf(pattern), `${field}.`)) > 0

/**
 * Tests the parts of a rule that do not need the resource value: the action,
 * the kind and the field.
 *
 * A rule with an empty list of fields covers no request. A rule with fields
 * covers a request with no field only when it is an allow rule. So "may update some fields" is a yes. A deny rule for some fields does
 * not stop a request for the whole value.
 *
 * @stability stable
 * @category predicates
 * @since 0.4.0
 */
export const matchesTarget = (
	rule: Any,
	target: {
		readonly action: string
		readonly kind: string
		readonly field?: string | undefined
	},
): boolean => {
	if (!rule.actions.includes("*") && !rule.actions.includes(target.action)) {
		return false
	}
	if (!rule.resources.includes("*") && !rule.resources.includes(target.kind)) {
		return false
	}
	if (rule.fields === undefined) {
		return true
	}
	// A rule for no fields is a rule for nothing. A grant with its last field
	// taken away must not cover the whole value.
	if (rule.fields.length === 0) {
		return false
	}
	if (target.field === undefined) {
		return rule._tag === "Allow"
	}
	const field = target.field
	return rule.fields.some((pattern) => matchesField(pattern, field))
}
