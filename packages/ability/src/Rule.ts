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
import type * as Equal from "effect/Equal"
import type * as Inspectable from "effect/Inspectable"
import type * as Pipeable from "effect/Pipeable"
import type * as Condition from "./Condition.ts"
import type * as Domain from "./Domain.ts"
import * as internal from "./internal/rule.ts"
import type * as Resource from "./Resource.ts"

/**
 * @stability stable
 * @category type IDs
 * @since 0.3.0
 */
export const TypeId: "~@nmnmcc/ability/Rule" = internal.TypeId

/**
 * @stability stable
 * @category type IDs
 * @since 0.3.0
 */
export type TypeId = typeof TypeId

/**
 * A rule. `E`, `R` and `O` come from its condition. See
 * `Condition.Condition`.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Rule<E = never, R = never, O = never>
	extends Equal.Equal, Inspectable.Inspectable, Pipeable.Pipeable {
	readonly [TypeId]: TypeId
	readonly _tag: "Allow" | "Deny"
	readonly actions: ReadonlyArray<string>
	readonly resources: ReadonlyArray<string>
	readonly when?: Condition.Ast
	readonly fields?: ReadonlyArray<string>
	readonly reason?: string
	readonly id?: string
	readonly meta?: unknown
	readonly "~Rule"?: Condition.Variance<E, R, O>
	[Symbol.iterator](): Generator<Rule<E, R, O>, Rule<E, R, O>, unknown>
}

/**
 * Any rule.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Any = Rule<any, any, any>

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
	Condition.FieldPath<DataFor<D, K>> | `${string}*${string}`

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
		const T extends Target<D>,
		const A extends ActionFor<D, KindOf<T>>,
		const C extends Condition.Any = Condition.Condition,
	>(
		action: SingleOrArray<A>,
		resource: SingleOrArray<T>,
		options?: Options<D, KindOf<T>, C>,
	) => Rule<Condition.Error<C>, Condition.Services<C>, Condition.OpaqueOf<C>>
	readonly deny: <
		const T extends Target<D>,
		const A extends ActionFor<D, KindOf<T>>,
		const C extends Condition.Any = Condition.Condition,
	>(
		action: SingleOrArray<A>,
		resource: SingleOrArray<T>,
		options?: Options<D, KindOf<T>, C>,
	) => Rule<Condition.Error<C>, Condition.Services<C>, Condition.OpaqueOf<C>>
}

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
export const builder: <D extends Domain.Any>(domain: D) => Builder<D> =
	internal.builder

/**
 * Tests if a value is a rule.
 *
 * @stability stable
 * @category guards
 * @since 0.3.0
 */
export const isRule: (u: unknown) => u is Any = internal.isRule

/**
 * Tests if a field name matches a field name or a field pattern of a rule.
 *
 * @stability stable
 * @category predicates
 * @since 0.3.0
 */
export const matchesField: (pattern: string, field: string) => boolean =
	internal.matchesFieldPattern
