/**
 * A condition is a test on a resource value. A rule applies only when its
 * condition is true.
 *
 * A condition is plain data: a tree of nodes. So you can:
 * - test it on a value with {@link evaluate};
 * - put the principal into it and make it smaller with {@link partial}, which
 *   gives a "residual" condition: the part that still depends on the
 *   resource;
 * - change it into a database query with {@link fold};
 * - keep it as JSON with {@link schema}.
 *
 * Make conditions with a {@link Builder}. A rule gives you a builder for its
 * resource, so the field names and the value types are checked.
 *
 * {@link Builder.predicate} is the one way out of plain data. A predicate runs
 * any `Effect`. Its error type and its service type go into the type of the
 * check. A rule with a predicate can not become JSON, and the type system
 * stops you when you try.
 *
 * @stability stable
 * @since 0.3.0
 */
import type * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import * as internal from "./internal/condition.ts"
import type * as Resource from "./Resource.ts"

/**
 * A value that a condition can compare.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Scalar = string | number | boolean | null

/**
 * A fixed value in a condition.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Literal {
	readonly _tag: "Literal"
	readonly value: Scalar
}

/**
 * A field of the principal. {@link partial} puts the value of the field in its
 * place.
 *
 * A principal field that is `null` or missing has no value. A `Compare`, `In`
 * or `Under` test with it is always false, also with `ne`. So a principal with
 * no id never matches a resource with no owner. `not` still turns false into
 * true.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface PrincipalRef {
	readonly _tag: "Principal"
	readonly path: string
}

/**
 * A field of the principal with a known value type.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Ref<A> = PrincipalRef & { readonly "~Ref"?: () => A }

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Operand = Literal | PrincipalRef

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type CompareOperator = "eq" | "ne" | "lt" | "lte" | "gt" | "gte"

/**
 * Always true.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface True {
	readonly _tag: "True"
}

/**
 * Always false.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface False {
	readonly _tag: "False"
}

/**
 * Compares a field with a value. A missing field has the value `null`. `lt`,
 * `lte`, `gt` and `gte` are false when the two sides are not both numbers or
 * both strings.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Compare {
	readonly _tag: "Compare"
	readonly op: CompareOperator
	readonly field: string
	readonly value: Operand
}

/**
 * True when a field is equal to one of the values.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface In {
	readonly _tag: "In"
	readonly field: string
	readonly values: ReadonlyArray<Operand>
}

/**
 * True when a field is not `null` and not missing.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Exists {
	readonly _tag: "Exists"
	readonly field: string
}

/**
 * True when the path of the resource starts with the prefix. A resource with
 * no path is never under a prefix.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Under {
	readonly _tag: "Under"
	readonly prefix: ReadonlyArray<Operand>
}

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface And {
	readonly _tag: "And"
	readonly conditions: ReadonlyArray<Ast>
}

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Or {
	readonly _tag: "Or"
	readonly conditions: ReadonlyArray<Ast>
}

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Not {
	readonly _tag: "Not"
	readonly condition: Ast
}

/**
 * A test that runs an `Effect`. It can not become JSON or a query.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Predicate {
	readonly _tag: "Predicate"
	readonly name: string
	readonly run: (
		value: any,
		principal: any,
	) => Effect.Effect<boolean, unknown, unknown>
}

/**
 * The nodes of a condition, without types.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Ast =
	True | False | Compare | In | Exists | Under | And | Or | Not | Predicate

/**
 * The type marker for a condition with a {@link Predicate}.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Opaque = "Opaque"

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Variance<E, R, O> {
	readonly E: () => E
	readonly R: () => R
	readonly O: () => O
}

/**
 * A condition. `E` and `R` are the error type and the service type of its
 * predicates. `O` is {@link Opaque} when the condition has a predicate, and
 * `never` when it is plain data.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Condition<E = never, R = never, O = never> = Ast & {
	readonly "~Condition"?: Variance<E, R, O>
}

/**
 * Any condition.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Any = Condition<any, any, any>

/**
 * The error type of a condition.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Error<C> = C extends {
	readonly "~Condition"?: Variance<infer E, infer _R, infer _O>
}
	? E
	: never

/**
 * The service type of a condition.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Services<C> = C extends {
	readonly "~Condition"?: Variance<infer _E, infer R, infer _O>
}
	? R
	: never

/**
 * {@link Opaque} when a condition has a predicate.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type OpaqueOf<C> = C extends {
	readonly "~Condition"?: Variance<infer _E, infer _R, infer O>
}
	? O
	: never

type Leaf = string | number | boolean | bigint | symbol | null | undefined
type PreviousDepth = [never, 0, 1, 2, 3]
type FieldPathInternal<T, Depth extends number> = [Depth] extends [never]
	? never
	: {
			[K in keyof T & string]-?: NonNullable<T[K]> extends Leaf
				? K
				: NonNullable<T[K]> extends ReadonlyArray<unknown> | Function
					? never
					: NonNullable<T[K]> extends object
						? `${K}.${FieldPathInternal<NonNullable<T[K]>, PreviousDepth[Depth]>}`
						: never
		}[keyof T & string]

/**
 * The paths of the fields of `T` that hold one value, with dots for nested
 * fields. Arrays are left out. The type goes down four levels, so type
 * checking stays fast. For a union of types, only the common fields are
 * paths.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type FieldPath<T> = [T] extends [object]
	? FieldPathInternal<T, 4>
	: never

type Normalize<A> = Exclude<A, undefined> | (undefined extends A ? null : never)

/**
 * The type of the field of `T` at `Path`. A field that may be missing may also
 * be `null`.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type PathValue<
	T,
	Path extends string,
> = Path extends `${infer Head}.${infer Rest}`
	? Head extends keyof T
		? undefined extends T[Head]
			? PathValue<NonNullable<T[Head]>, Rest> | null
			: null extends T[Head]
				? PathValue<NonNullable<T[Head]>, Rest> | null
				: PathValue<T[Head], Rest>
		: never
	: Path extends keyof T
		? Normalize<T[Path]>
		: never

/**
 * A value for a field of type `A`: a fixed value, or a field of the principal
 * with the same type.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type OperandOf<A> = Extract<A, Scalar> | Ref<A>

type OrderedPath<T> = {
	[F in FieldPath<T>]: Exclude<PathValue<T, F>, null> extends number | string
		? F
		: never
}[FieldPath<T>]

/**
 * Makes conditions for a resource with the data type `Data` and the value type
 * `Value`, and a principal with the type `P`.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Builder<Data, Value, P> {
	/** The field is equal to the value. */
	readonly eq: <const F extends FieldPath<Data>>(
		field: F,
		value: OperandOf<PathValue<Data, F>>,
	) => Condition
	/** The field is not equal to the value. */
	readonly ne: <const F extends FieldPath<Data>>(
		field: F,
		value: OperandOf<PathValue<Data, F>>,
	) => Condition
	readonly lt: <const F extends OrderedPath<Data>>(
		field: F,
		value: OperandOf<Exclude<PathValue<Data, F>, null>>,
	) => Condition
	readonly lte: <const F extends OrderedPath<Data>>(
		field: F,
		value: OperandOf<Exclude<PathValue<Data, F>, null>>,
	) => Condition
	readonly gt: <const F extends OrderedPath<Data>>(
		field: F,
		value: OperandOf<Exclude<PathValue<Data, F>, null>>,
	) => Condition
	readonly gte: <const F extends OrderedPath<Data>>(
		field: F,
		value: OperandOf<Exclude<PathValue<Data, F>, null>>,
	) => Condition
	/** The field is equal to one of the values. */
	readonly in: <const F extends FieldPath<Data>>(
		field: F,
		values: ReadonlyArray<OperandOf<PathValue<Data, F>>>,
	) => Condition
	/** The field has a value that is not `null`. */
	readonly exists: <const F extends FieldPath<Data>>(field: F) => Condition
	/** The path of the resource starts with these parts. */
	readonly under: (
		...prefix: ReadonlyArray<string | null | Ref<string | null>>
	) => Condition
	/** A field of the principal, to use as a value. */
	readonly principal: <const F extends FieldPath<P>>(
		field: F,
	) => Ref<PathValue<P, F>>
	readonly and: <const Cs extends ReadonlyArray<Any>>(
		...conditions: Cs
	) => Condition<Error<Cs[number]>, Services<Cs[number]>, OpaqueOf<Cs[number]>>
	readonly or: <const Cs extends ReadonlyArray<Any>>(
		...conditions: Cs
	) => Condition<Error<Cs[number]>, Services<Cs[number]>, OpaqueOf<Cs[number]>>
	readonly not: <C extends Any>(
		condition: C,
	) => Condition<Error<C>, Services<C>, OpaqueOf<C>>
	/**
	 * A test that runs any code. It may give a boolean or an `Effect`. A
	 * condition with a predicate can not become JSON or a query.
	 */
	readonly predicate: <E = never, R = never>(
		name: string,
		test: (
			value: Value,
			principal: P,
		) => boolean | Effect.Effect<boolean, E, R>,
	) => Condition<E, R, Opaque>
}

/**
 * Makes a builder. Rules give you a builder with the right types, so you do not
 * often need this.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const builder: <Data, Value, P>() => Builder<Data, Value, P> =
	internal.builder

/**
 * Always true.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const always: Condition = internal.always

/**
 * Always false.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const never: Condition = internal.never

/**
 * True when all the conditions are true. With no conditions, it is true.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const and: <const Cs extends ReadonlyArray<Any>>(
	...conditions: Cs
) => Condition<Error<Cs[number]>, Services<Cs[number]>, OpaqueOf<Cs[number]>> =
	internal.and as never

/**
 * True when one of the conditions is true. With no conditions, it is false.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const or: <const Cs extends ReadonlyArray<Any>>(
	...conditions: Cs
) => Condition<Error<Cs[number]>, Services<Cs[number]>, OpaqueOf<Cs[number]>> =
	internal.or as never

/**
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const not: <C extends Any>(
	condition: C,
) => Condition<Error<C>, Services<C>, OpaqueOf<C>> = internal.not as never

/**
 * The data that a condition needs for a test.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Input {
	/** The resource value. */
	readonly value: object
	/**
	 * The principal. Without it, a principal field has no value. See
	 * {@link PrincipalRef}.
	 */
	readonly principal?: object | undefined
	/** The path of the resource. Without it, `Under` is false. */
	readonly path?: ReadonlyArray<Resource.PathSegment> | undefined
}

/**
 * Tests a condition on a value. A predicate may fail with its error.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const evaluate: {
	(
		input: Input,
	): <E, R, O>(condition: Condition<E, R, O>) => Effect.Effect<boolean, E, R>
	<E, R, O>(
		condition: Condition<E, R, O>,
		input: Input,
	): Effect.Effect<boolean, E, R>
} = internal.evaluate as never

/**
 * Tests a condition with no predicate on a value, at once.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const evaluateSync: {
	(input: Input): (condition: Condition) => boolean
	(condition: Condition, input: Input): boolean
} = internal.evaluateSync

/**
 * Puts the principal into a condition and expands `Under` with the path of the
 * resource. The result is simplified. It has no principal fields and no
 * `Under` nodes. It is `True` or `False` when the answer does not depend on the
 * resource value.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const partial: {
	(input: {
		readonly principal?: object | undefined
		readonly path?: ReadonlyArray<Resource.PathSegment> | undefined
	}): <E, R, O>(condition: Condition<E, R, O>) => Condition<E, R, O>
	<E, R, O>(
		condition: Condition<E, R, O>,
		input: {
			readonly principal?: object | undefined
			readonly path?: ReadonlyArray<Resource.PathSegment> | undefined
		},
	): Condition<E, R, O>
} = internal.partial as never

/**
 * Puts known field values into a condition. Each test on one of these fields
 * becomes `True` or `False`, and the result is simplified. Tests on other
 * fields stay. A test that still uses a principal field stays too, so call
 * {@link partial} first.
 *
 * Use it to ask about a part of a kind, such as "the Bots of this user".
 *
 * @stability stable
 * @category evaluation
 * @since 0.4.0
 */
export const assign: {
	(
		values: Readonly<Record<string, Scalar>>,
	): <E, R, O>(condition: Condition<E, R, O>) => Condition<E, R, O>
	<E, R, O>(
		condition: Condition<E, R, O>,
		values: Readonly<Record<string, Scalar>>,
	): Condition<E, R, O>
} = internal.assign as never

/**
 * Makes a condition smaller without a change to its meaning. It removes `True`
 * and `False` from `And` and `Or`, joins nested `And` and `Or` nodes, and
 * removes double `Not` nodes.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const simplify: <E, R, O>(
	condition: Condition<E, R, O>,
) => Condition<E, R, O> = internal.simplify as never

/**
 * The functions that change each node of a condition into another form, such
 * as a database query.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Interpreter<A> {
	readonly true: () => A
	readonly false: () => A
	readonly compare: (op: CompareOperator, field: string, value: Scalar) => A
	readonly in: (field: string, values: ReadonlyArray<Scalar>) => A
	readonly exists: (field: string) => A
	readonly and: (conditions: ReadonlyArray<A>) => A
	readonly or: (conditions: ReadonlyArray<A>) => A
	readonly not: (condition: A) => A
	/** Optional. Without it, a predicate makes `fold` fail. */
	readonly predicate?: (name: string) => A
}

/**
 * The error when `fold` can not change a node.
 *
 * @stability stable
 * @category errors
 * @since 0.3.0
 */
export const Untranslatable: typeof internal.Untranslatable =
	internal.Untranslatable

/**
 * @stability stable
 * @category errors
 * @since 0.3.0
 */
export type Untranslatable = internal.Untranslatable

/**
 * Changes a condition into another form with an interpreter. Call
 * {@link partial} first: `fold` fails on principal fields and on `Under`
 * nodes, and on predicates when the interpreter has no `predicate` function.
 *
 * @stability stable
 * @category converting
 * @since 0.3.0
 */
export const fold: {
	<A>(
		interpreter: Interpreter<A>,
	): (condition: Any) => Effect.Effect<A, Untranslatable>
	<A>(
		condition: Any,
		interpreter: Interpreter<A>,
	): Effect.Effect<A, Untranslatable>
} = internal.fold

/**
 * The fields that a condition uses.
 *
 * @stability stable
 * @category getters
 * @since 0.3.0
 */
export const fields: (condition: Any) => ReadonlyArray<string> = internal.fields

/**
 * The JSON form of a condition with no predicate.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Encoded =
	Exclude<Ast, Predicate | And | Or | Not> | EncodedAnd | EncodedOr | EncodedNot

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface EncodedAnd {
	readonly _tag: "And"
	readonly conditions: ReadonlyArray<Encoded>
}

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface EncodedOr {
	readonly _tag: "Or"
	readonly conditions: ReadonlyArray<Encoded>
}

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface EncodedNot {
	readonly _tag: "Not"
	readonly condition: Encoded
}

/**
 * The Schema of a condition with no predicate. It checks the shape only. Use
 * `Policy.schema` to check the field names against a domain too.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export const schema: Schema.Codec<Condition, Encoded> = internal.schema
