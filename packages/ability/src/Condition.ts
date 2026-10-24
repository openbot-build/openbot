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
// A predicate keeps its error type and service type in the public types. The
// code below works on the nodes with no types, where they are `unknown`, so
// the language service check for `unknown` in an Effect is off here.
// @effect-diagnostics anyUnknownInErrorContext:off
import * as Arr from "effect/Array"
import type * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { dual } from "effect/Function"
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import * as MutableHashMap from "effect/MutableHashMap"
import { hasProperty, isObject } from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Resource from "./Resource.ts"

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
 * A field of the principal with a known value type `A`, from a principal of
 * the type `P`. The type fields are only in the types. A reference with no
 * type does not have them, so it can not stand for a field of any type. A
 * test with the reference reads a principal of the type `P`, so it can not go
 * into a rule of a domain with another principal. With no `P`, it is `never`,
 * and a test with the reference fits no rule.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Ref<A, P = never> = PrincipalRef & {
	readonly "~Ref": () => A
	readonly "~Principal": (principal: P) => void
}

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
	// A method, so the typed `run` of `PredicateCondition`, with inputs of the
	// type `never`, is a `run` of this node too.
	run(value: any, principal: any): Effect.Effect<boolean, unknown, unknown>
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
 * What the predicates of a condition read: a resource value of the type `V`
 * and a principal of the type `P`. It is only in the types.
 *
 * @stability stable
 * @category models
 * @since 0.4.0
 */
export interface Reads<V, P> {
	readonly value: V
	readonly principal: P
}

/**
 * The type fields of a condition. They are only in the types.
 *
 * @stability stable
 * @category models
 * @since 0.4.0
 */
export interface Marks<E, R, O, I> {
	readonly "~Condition": Variance<E, R, O>
	/** `I` is what the predicates read. See {@link Reads}. */
	readonly "~Reads": (reads: I) => void
}

/**
 * An `And` node with the types of its children.
 *
 * @stability stable
 * @category models
 * @since 0.4.0
 */
export interface AndCondition<E, R, O, I> extends Marks<E, R, O, I> {
	readonly _tag: "And"
	readonly conditions: ReadonlyArray<Condition<E, R, O, I>>
}

/**
 * An `Or` node with the types of its children.
 *
 * @stability stable
 * @category models
 * @since 0.4.0
 */
export interface OrCondition<E, R, O, I> extends Marks<E, R, O, I> {
	readonly _tag: "Or"
	readonly conditions: ReadonlyArray<Condition<E, R, O, I>>
}

/**
 * A `Not` node with the types of its child.
 *
 * @stability stable
 * @category models
 * @since 0.4.0
 */
export interface NotCondition<E, R, O, I> extends Marks<E, R, O, I> {
	readonly _tag: "Not"
	readonly condition: Condition<E, R, O, I>
}

/**
 * A predicate node with its types. `"~Predicate"` is only in the types. It has
 * the type `O`, so a plain condition, with `O` as `never`, can not be a
 * predicate. The builder makes predicates with `O` as {@link Opaque}.
 *
 * @stability stable
 * @category models
 * @since 0.4.0
 */
export interface PredicateCondition<E, R, O, I> extends Marks<E, R, O, I> {
	readonly _tag: "Predicate"
	readonly name: string
	/**
	 * The test. Its inputs have the type `never`, so it can not be called with
	 * a value that it does not read. Use {@link evaluate}, which checks the
	 * input against `I`.
	 */
	readonly run: (value: never, principal: never) => Effect.Effect<boolean, E, R>
	readonly "~Predicate": O
}

/**
 * A condition. `E` and `R` are the error type and the service type of its
 * predicates. `O` is {@link Opaque} when the condition has a predicate, and
 * `never` when it is plain data. `I` is what its predicates read. See
 * {@link Reads}.
 *
 * The type fields are only in the types. A plain node made by hand does not
 * have them, so it is not a condition. Use the builder. Each child of a node
 * is a condition with the same types, so a node can not hide the types of a
 * predicate inside it. A predicate is a condition only when `O` is
 * {@link Opaque}.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Condition<E = never, R = never, O = never, I = unknown> =
	| ((True | False | Compare | In | Exists | Under) & Marks<E, R, O, I>)
	| AndCondition<E, R, O, I>
	| OrCondition<E, R, O, I>
	| NotCondition<E, R, O, I>
	| PredicateCondition<E, R, O, I>

/**
 * Any condition.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Any = Condition<any, any, any, any>

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
 * What the predicates of a condition read. For a union of conditions, it is
 * what all of them read.
 *
 * @stability stable
 * @category utility types
 * @since 0.4.0
 */
export type ReadsOf<C> = [C] extends [
	{ readonly "~Reads": (reads: infer I) => void },
]
	? I
	: unknown

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
/**
 * Values of a class that keeps its data inside. A path does not go into them,
 * as in the field paths of a resource, so a field with such a value is one
 * field. A condition can test only if it exists.
 */
type Whole =
	| ReadonlyMap<unknown, unknown>
	| ReadonlySet<unknown>
	| HashMap.HashMap<unknown, unknown>
	| HashSet.HashSet<unknown>
	| Date
	| URL
	| Uint8Array
	| Option.Option<unknown>
type PreviousDepth = [never, 0, 1, 2, 3]
type FieldPathInternal<T, Depth extends number, Arrays extends boolean> = [
	Depth,
] extends [never]
	? never
	: {
			[K in keyof T & string]-?: NonNullable<T[K]> extends Leaf | Whole
				? K
				: NonNullable<T[K]> extends Function
					? never
					: NonNullable<T[K]> extends ReadonlyArray<unknown>
						? Arrays extends true
							? K
							: never
						: NonNullable<T[K]> extends object
							? `${K}.${FieldPathInternal<NonNullable<T[K]>, PreviousDepth[Depth], Arrays>}`
							: never
		}[keyof T & string]

/**
 * The paths of the fields of `T` that hold one value, with dots for nested
 * fields. Arrays are left out. A map, a set, a date, a URL, a byte array and
 * an `Option` are one field, and a path does not go into them. The type goes down four levels, so type
 * checking stays fast. For a union of types, only the common fields are
 * paths.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type FieldPath<T> = [T] extends [object]
	? FieldPathInternal<T, 4, false>
	: never

/**
 * The paths of the fields of `T` that a rule or a request may name, as in
 * `Rule.Options.fields`. They are the paths of {@link FieldPath}, and the
 * paths of arrays too: a rule may allow or deny a whole array field, and
 * `permittedFields` lists it.
 *
 * @stability stable
 * @category utility types
 * @since 0.5.0
 */
export type FieldSelector<T> = [T] extends [object]
	? FieldPathInternal<T, 4, true>
	: never

/**
 * The value type that fits every field in `F`. For one field, it is the type
 * of the field. For a union of fields, it is the values that each of them can
 * hold, so a value of a union type can not test a field of another type.
 *
 * @stability stable
 * @category utility types
 * @since 0.5.0
 */
export type FieldValue<Data, F extends string> = (
	F extends unknown ? (value: PathValue<Data, F>) => void : never
) extends (value: infer V) => void
	? V
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
export type OperandOf<A, P = never> = Extract<A, Scalar> | Ref<A, P>

type ScalarPath<T> = {
	[F in FieldPath<T>]: PathValue<T, F> extends Scalar ? F : never
}[FieldPath<T>]

type OrderedPath<T> = {
	[F in FieldPath<T>]: Exclude<PathValue<T, F>, null> extends number | string
		? F
		: never
}[FieldPath<T>]

/**
 * A test made by a {@link Builder}. It runs no code, but it keeps the value
 * type of its resource, so a test on the fields of one resource can not go
 * into a rule for another resource. A test with a field of the principal
 * keeps the principal type `P` too.
 *
 * @stability stable
 * @category models
 * @since 0.4.0
 */
export type Test<Value, P = unknown> = Condition<
	never,
	never,
	never,
	Reads<Value, P>
>

/**
 * The principal type that a test reads: the principal of each field of the
 * principal in the values `V`, and `unknown` when there is none. A reference
 * from another builder keeps the principal of that builder.
 */
type PrincipalOf<V, _P> = [Extract<V, PrincipalRef>] extends [never]
	? unknown
	: [Extract<V, PrincipalRef>] extends [
				{ readonly "~Principal": (principal: infer Q) => void },
		  ]
		? Q
		: unknown

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
	readonly eq: <
		const F extends FieldPath<Data>,
		const V extends OperandOf<FieldValue<Data, F>, any>,
	>(
		field: F,
		value: V,
	) => Test<Value, PrincipalOf<V, P>>
	/** The field is not equal to the value. */
	readonly ne: <
		const F extends FieldPath<Data>,
		const V extends OperandOf<FieldValue<Data, F>, any>,
	>(
		field: F,
		value: V,
	) => Test<Value, PrincipalOf<V, P>>
	readonly lt: <
		const F extends OrderedPath<Data>,
		const V extends OperandOf<Exclude<FieldValue<Data, F>, null>, any>,
	>(
		field: F,
		value: V,
	) => Test<Value, PrincipalOf<V, P>>
	readonly lte: <
		const F extends OrderedPath<Data>,
		const V extends OperandOf<Exclude<FieldValue<Data, F>, null>, any>,
	>(
		field: F,
		value: V,
	) => Test<Value, PrincipalOf<V, P>>
	readonly gt: <
		const F extends OrderedPath<Data>,
		const V extends OperandOf<Exclude<FieldValue<Data, F>, null>, any>,
	>(
		field: F,
		value: V,
	) => Test<Value, PrincipalOf<V, P>>
	readonly gte: <
		const F extends OrderedPath<Data>,
		const V extends OperandOf<Exclude<FieldValue<Data, F>, null>, any>,
	>(
		field: F,
		value: V,
	) => Test<Value, PrincipalOf<V, P>>
	/** The field is equal to one of the values. */
	readonly in: <
		const F extends FieldPath<Data>,
		const Vs extends ReadonlyArray<OperandOf<FieldValue<Data, F>, any>>,
	>(
		field: F,
		values: Vs,
	) => Test<Value, PrincipalOf<Vs[number], P>>
	/** The field has a value that is not `null`. */
	readonly exists: <const F extends FieldPath<Data>>(field: F) => Test<Value>
	/** The path of the resource starts with these parts. */
	readonly under: <
		const Ps extends ReadonlyArray<string | null | Ref<string | null, any>>,
	>(
		...prefix: Ps
	) => Test<Value, PrincipalOf<Ps[number], P>>
	/**
	 * A field of the principal, to use as a value. The field must have a
	 * {@link Scalar} type.
	 */
	readonly principal: <const F extends ScalarPath<P>>(
		field: F,
	) => Ref<PathValue<P, F>, P>
	readonly and: <const Cs extends ReadonlyArray<Any>>(
		...conditions: Cs
	) => Condition<
		Error<Cs[number]>,
		Services<Cs[number]>,
		OpaqueOf<Cs[number]>,
		ReadsOf<Cs[number]>
	>
	readonly or: <const Cs extends ReadonlyArray<Any>>(
		...conditions: Cs
	) => Condition<
		Error<Cs[number]>,
		Services<Cs[number]>,
		OpaqueOf<Cs[number]>,
		ReadsOf<Cs[number]>
	>
	readonly not: <C extends Any>(
		condition: C,
	) => Condition<Error<C>, Services<C>, OpaqueOf<C>, ReadsOf<C>>
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
	) => Condition<E, R, Opaque, Reads<Value, P>>
}

const nodes = Data.taggedEnum<Ast>()
const operands = Data.taggedEnum<Operand>()

const literal = (value: Scalar): Literal => operands.Literal({ value })

const isOperand = (u: unknown): u is Operand =>
	hasProperty(u, "_tag") && (u._tag === "Literal" || u._tag === "Principal")

const toOperand = (value: unknown): Operand =>
	isOperand(value) ? value : literal(value as Scalar)

const compare =
	(op: CompareOperator) =>
	(field: string, value: unknown): Compare =>
		nodes.Compare({ op, field, value: toOperand(value) })

const makeAnd = (...conditions: ReadonlyArray<Ast>): Ast =>
	nodes.And({ conditions })

const makeOr = (...conditions: ReadonlyArray<Ast>): Ast =>
	nodes.Or({ conditions })

const makeNot = (condition: Ast): Ast => nodes.Not({ condition })

const makePredicate = (
	name: string,
	run: (value: unknown, principal: unknown) => Effect.Effect<boolean, any, any>,
): Ast => nodes.Predicate({ name, run })

const sharedBuilder: Builder<any, any, any> = {
	eq: compare("eq"),
	ne: compare("ne"),
	lt: compare("lt"),
	lte: compare("lte"),
	gt: compare("gt"),
	gte: compare("gte"),
	in: (field: string, values: ReadonlyArray<unknown>) =>
		nodes.In({ field, values: values.map(toOperand) }),
	exists: (field: string) => nodes.Exists({ field }),
	under: (...prefix: ReadonlyArray<unknown>) =>
		nodes.Under({ prefix: prefix.map(toOperand) }),
	principal: (path: string) => operands.Principal({ path }),
	and: makeAnd,
	or: makeOr,
	not: makeNot,
	predicate: (
		name: string,
		test: (
			value: unknown,
			principal: unknown,
		) => boolean | Effect.Effect<boolean, unknown, unknown>,
	) =>
		makePredicate(name, (value, principal) =>
			Effect.suspend(() => {
				const result = test(value, principal)
				return Effect.isEffect(result) ? result : Effect.succeed(result)
			}),
		),
} as never

/**
 * Makes a builder. Rules give you a builder with the right types, so you do not
 * often need this.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const builder = <Data, Value, P>(): Builder<Data, Value, P> =>
	sharedBuilder

/**
 * Always true.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const always: Condition = nodes.True() as Condition

/**
 * Always false.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const never: Condition = nodes.False() as Condition

/**
 * True when all the conditions are true. With no conditions, it is true.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const and: <const Cs extends ReadonlyArray<Any>>(
	...conditions: Cs
) => Condition<
	Error<Cs[number]>,
	Services<Cs[number]>,
	OpaqueOf<Cs[number]>,
	ReadsOf<Cs[number]>
> = makeAnd as never

/**
 * True when one of the conditions is true. With no conditions, it is false.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const or: <const Cs extends ReadonlyArray<Any>>(
	...conditions: Cs
) => Condition<
	Error<Cs[number]>,
	Services<Cs[number]>,
	OpaqueOf<Cs[number]>,
	ReadsOf<Cs[number]>
> = makeOr as never

/**
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const not: <C extends Any>(
	condition: C,
) => Condition<Error<C>, Services<C>, OpaqueOf<C>, ReadsOf<C>> =
	makeNot as never

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
 * Gets a field of an object by a path with dots. A missing field, or a field
 * under a value that is not an object, gives `null`.
 */
const getField = (value: unknown, path: string): unknown =>
	Option.match(
		Arr.reduce(path.split("."), Option.some(value), (cursor, key) =>
			Option.flatMap(cursor, (current) =>
				isObject(current) && Object.hasOwn(current, key)
					? Option.some((current as Record<string, unknown>)[key])
					: Option.none(),
			),
		),
		{
			onNone: () => null,
			onSome: (field) => (field === undefined ? null : field),
		},
	)

const isScalar = (value: unknown): value is Scalar =>
	typeof value === "string" ||
	typeof value === "boolean" ||
	(typeof value === "number" && Number.isFinite(value))

/**
 * Gives the value of an operand. A principal field that is `null`, missing, or
 * not a {@link Scalar} gives `undefined`. No field of a resource is
 * `undefined`, so a test with it is never true. This keeps the check closed: a
 * principal with no id never matches a resource with no owner. It also keeps
 * other values, such as a `bigint`, out of the residual condition.
 */
const resolve = (operand: Operand, principal: unknown): unknown => {
	if (operand._tag === "Literal") {
		return operand.value
	}
	const value = getField(principal, operand.path)
	return isScalar(value) ? value : undefined
}

const testCompare = (
	op: CompareOperator,
	left: unknown,
	right: unknown,
): boolean => {
	if (right === undefined) {
		return false
	}
	switch (op) {
		case "eq":
			return left === right
		case "ne":
			return left !== right
		default: {
			const ordered =
				(typeof left === "number" && typeof right === "number") ||
				(typeof left === "string" && typeof right === "string")
			if (!ordered) {
				return false
			}
			const a = left as number | string
			const b = right as number | string
			switch (op) {
				case "lt":
					return a < b
				case "lte":
					return a <= b
				case "gt":
					return a > b
				case "gte":
					return a >= b
			}
		}
	}
}

/**
 * Gives the values of a resource path. It gives `undefined` when the resource
 * has no path.
 */
const pathValues = (
	value: unknown,
	path: ReadonlyArray<Resource.PathSegment> | undefined,
): ReadonlyArray<unknown> | undefined =>
	path?.map((segment) =>
		typeof segment === "string" ? segment : getField(value, segment.field),
	)

const testUnder = (prefix: ReadonlyArray<Operand>, input: Input): boolean => {
	const values = pathValues(input.value, input.path)
	if (values === undefined || prefix.length > values.length) {
		return false
	}
	return prefix.every(
		(operand, index) => resolve(operand, input.principal) === values[index],
	)
}

/**
 * True when a condition has a {@link Predicate}.
 *
 * @stability stable
 * @category predicates
 * @since 0.4.0
 */
export const hasPredicate = (condition: Ast): boolean =>
	hasPredicateIn(condition, new Map())

// One node may be a child of many nodes. Each walk below keeps its work on a
// node in a memo that the walk makes for itself, so a condition with shared
// children takes time for its nodes, not for its paths. No memo lives longer
// than one call.

/**
 * Gives the answer for a key from the memo, or works it out and keeps it.
 *
 * A memo keyed by a node is a native `Map`, because it must find a node by
 * the node itself. An Effect `HashMap` finds a key by `Equal`, and the nodes
 * are Effect data, so it would hash the whole structure of a node, and a
 * shared child again for each path to it.
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

const hasPredicateIn = (ast: Ast, memo: Map<Ast, boolean>): boolean =>
	remember(memo, ast, () => {
		switch (ast._tag) {
			case "Predicate":
				return true
			case "And":
			case "Or":
				return Arr.some(ast.conditions, (child) => hasPredicateIn(child, memo))
			case "Not":
				return hasPredicateIn(ast.condition, memo)
			default:
				return false
		}
	})

const provideAst = (
	ast: Ast,
	context: Context.Context<never>,
	done: Map<Ast, Ast> = new Map(),
	predicates: Map<Ast, boolean> = new Map(),
): Ast =>
	!hasPredicateIn(ast, predicates)
		? ast
		: remember(done, ast, () => {
				const provide = (child: Ast) =>
					provideAst(child, context, done, predicates)
				switch (ast._tag) {
					case "Predicate":
						return makePredicate(ast.name, (value, principal) =>
							Effect.provideContext(ast.run(value, principal), context),
						)
					case "And":
						return makeAnd(...Arr.map(ast.conditions, provide))
					case "Or":
						return makeOr(...Arr.map(ast.conditions, provide))
					case "Not":
						return makeNot(provide(ast.condition))
					default:
						return ast
				}
			})

/**
 * Gives the services in `context` to every predicate of a condition, so the
 * condition needs no services when it runs.
 *
 * @stability stable
 * @category services
 * @since 0.4.0
 */
export const provideContext: {
	<R>(
		context: Context.Context<R>,
	): <E, O, I>(condition: Condition<E, R, O, I>) => Condition<E, never, O, I>
	<E, R, O, I>(
		condition: Condition<E, R, O, I>,
		context: Context.Context<R>,
	): Condition<E, never, O, I>
} = dual(2, provideAst) as never

const evaluateSyncAst = (ast: Ast, input: Input): boolean =>
	evaluateSyncNode(ast, input, new Map())

const evaluateSyncNode = (
	ast: Ast,
	input: Input,
	done: Map<Ast, boolean>,
): boolean => remember(done, ast, () => evaluateSyncOnce(ast, input, done))

const evaluateSyncOnce = (
	ast: Ast,
	input: Input,
	done: Map<Ast, boolean>,
): boolean => {
	switch (ast._tag) {
		case "True":
			return true
		case "False":
			return false
		case "Compare":
			return testCompare(
				ast.op,
				getField(input.value, ast.field),
				resolve(ast.value, input.principal),
			)
		case "In": {
			const field = getField(input.value, ast.field)
			return ast.values.some(
				(operand) => resolve(operand, input.principal) === field,
			)
		}
		case "Exists":
			return getField(input.value, ast.field) !== null
		case "Under":
			return testUnder(ast.prefix, input)
		case "And":
			return Arr.every(ast.conditions, (child) =>
				evaluateSyncNode(child, input, done),
			)
		case "Or":
			return Arr.some(ast.conditions, (child) =>
				evaluateSyncNode(child, input, done),
			)
		case "Not":
			return !evaluateSyncNode(ast.condition, input, done)
		case "Predicate":
			// The types stop this. A predicate needs `evaluate`.
			throw new globalThis.Error(
				`The predicate "${ast.name}" needs an Effect. Use Condition.evaluate.`,
			)
	}
}

const evaluateAst = (
	ast: Ast,
	input: Input,
	predicates: Map<Ast, boolean> = new Map(),
): Effect.Effect<boolean, unknown, unknown> => {
	if (!hasPredicateIn(ast, predicates)) {
		return Effect.sync(() => evaluateSyncAst(ast, input))
	}
	const evaluate = (child: Ast) => evaluateAst(child, input, predicates)
	switch (ast._tag) {
		case "Predicate":
			return ast.run(input.value, input.principal)
		case "Not":
			return Effect.map(evaluate(ast.condition), (value) => !value)
		case "And":
			// The children run in order, until one is false.
			return Effect.map(
				Effect.findFirst(ast.conditions, (child) =>
					Effect.map(evaluate(child), (value) => !value),
				),
				Option.isNone,
			)
		case "Or":
			// The children run in order, until one is true.
			return Effect.map(
				Effect.findFirst(ast.conditions, evaluate),
				Option.isSome,
			)
		default:
			return Effect.sync(() => evaluateSyncAst(ast, input))
	}
}

/**
 * The input of {@link evaluate} that the predicates of a condition need: a
 * value and a principal of the types in `I`. See {@link Reads}.
 */
type ReadsInput<I> =
	I extends Reads<infer V, infer P>
		? { readonly value: V } & (unknown extends P
				? unknown
				: { readonly principal: P })
		: unknown

/**
 * `unknown` when `In` gives what `I` reads, and `never` when it does not. For
 * a union, each member must give it, so the test is not split over the union.
 */
type ReadsFrom<I, In> = [In] extends [ReadsInput<I>] ? unknown : never

/**
 * Tests a condition on a value. A predicate may fail with its error. When the
 * condition has a predicate, the input must have the value and the principal
 * that the predicate reads.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const evaluate: {
	<In extends Input>(
		input: In,
	): <E, R, O, I>(
		condition: Condition<E, R, O, I> & ReadsFrom<I, In>,
	) => Effect.Effect<boolean, E, R>
	<E, R, O, I, In extends Input>(
		condition: Condition<E, R, O, I>,
		input: In & ReadsInput<I>,
	): Effect.Effect<boolean, E, R>
} = dual(2, evaluateAst) as never

/**
 * Tests a condition with no predicate on a value, at once.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const evaluateSync: {
	// A condition with no predicate reads nothing, so `I` does not matter.
	(input: Input): (condition: Condition<never, never, never, any>) => boolean
	(condition: Condition<never, never, never, any>, input: Input): boolean
} = dual(2, evaluateSyncAst)

/**
 * The memo of one simplification. One node may be a child of many nodes, so
 * the work on each node is done one time. The memo lives only as long as the
 * work that made it.
 */
interface Memo {
	/** The simple form of each node. */
	readonly simple: Map<Ast, Ast>
	readonly predicates: Map<Ast, boolean>
	/** A number for each node. Two nodes with one structure get one number. */
	readonly ids: Map<Ast, number>
	readonly structures: MutableHashMap.MutableHashMap<string, number>
}

const makeMemo = (): Memo => ({
	simple: new Map(),
	predicates: new Map(),
	ids: new Map(),
	structures: MutableHashMap.empty(),
})

const literalText = (value: Scalar): string =>
	// JSON gives `null` for `Infinity`, `-Infinity` and `NaN`, so a number is
	// given as its own text.
	typeof value === "number"
		? `n${Object.is(value, -0) ? "-0" : String(value)}`
		: `${typeof value}:${JSON.stringify(value)}`

const operandText = (operand: Operand): string =>
	operand._tag === "Literal"
		? `L${literalText(operand.value)}`
		: `R${JSON.stringify(operand.path)}`

const structureText = (ast: Ast, memo: Memo): string | undefined => {
	const id = (child: Ast) => structureId(child, memo)
	switch (ast._tag) {
		case "True":
		case "False":
			return ast._tag
		case "Compare":
			return `C${ast.op}:${JSON.stringify(ast.field)}:${operandText(ast.value)}`
		case "In":
			return `I${JSON.stringify(ast.field)}:${Arr.map(ast.values, operandText).join(",")}`
		case "Exists":
			return `E${JSON.stringify(ast.field)}`
		case "Under":
			return `U${Arr.map(ast.prefix, operandText).join(",")}`
		case "And":
		case "Or":
			return `${ast._tag}:${Arr.map(ast.conditions, id).join(",")}`
		case "Not":
			return `N${String(id(ast.condition))}`
		case "Predicate":
			// A predicate is equal only to itself.
			return undefined
	}
}

/**
 * Gives the number of the structure of a node. Two nodes with the same
 * structure get the same number, so a set of numbers finds an equal node at
 * once. The hash of Effect data would walk a shared child again for each path
 * to it. A new number is the count of the numbered nodes, so it is new.
 */
const structureId = (ast: Ast, memo: Memo): number =>
	remember(memo.ids, ast, () => {
		const text = structureText(ast, memo)
		const fresh = memo.ids.size
		if (text === undefined) {
			return fresh
		}
		return Option.getOrElse(MutableHashMap.get(memo.structures, text), () => {
			MutableHashMap.set(memo.structures, text, fresh)
			return fresh
		})
	})

const dedupe = (
	conditions: ReadonlyArray<Ast>,
	memo: Memo,
): ReadonlyArray<Ast> => {
	const ids = Arr.map(conditions, (condition) => structureId(condition, memo))
	// The first place of each number. The entries go in from the end, so the
	// first place is the one that stays.
	const first = HashMap.fromIterable(
		Arr.reverse(Arr.map(ids, (id, index) => [id, index] as const)),
	)
	return Arr.filter(conditions, (_, index) =>
		Option.contains(HashMap.get(first, ids[index]!), index),
	)
}

/**
 * Removes the children that the other children make useless. In an `Or`,
 * `a OR (a AND b)` is `a`. In an `And`, `a AND (a OR b)` is `a`. The
 * children are already without copies.
 */
const absorb = (
	inner: "And" | "Or",
	conditions: ReadonlyArray<Ast>,
	memo: Memo,
): ReadonlyArray<Ast> => {
	const all = HashSet.fromIterable(
		Arr.map(conditions, (condition) => structureId(condition, memo)),
	)
	return Arr.filter(
		conditions,
		(condition) =>
			condition._tag !== inner ||
			!Arr.some(condition.conditions, (part) =>
				HashSet.has(all, structureId(part, memo)),
			),
	)
}

/**
 * Removes children that do not change the result. A predicate may fail, and it
 * may give another answer when it runs again. So when a child has a predicate,
 * every child stays, and each one runs in its place.
 */
const reduce = (
	inner: "And" | "Or",
	conditions: ReadonlyArray<Ast>,
	memo: Memo,
): ReadonlyArray<Ast> =>
	Arr.some(conditions, (condition) =>
		hasPredicateIn(condition, memo.predicates),
	)
		? conditions
		: absorb(inner, dedupe(conditions, memo), memo)

/**
 * Puts the children of a child of the same kind into the node. A child with a
 * predicate stays one child: its children all stay anyway, and one shared
 * child would come again for each path to it, so the node could grow without
 * end.
 */
const flatten = (
	tag: "And" | "Or",
	conditions: ReadonlyArray<Ast>,
	memo: Memo,
): ReadonlyArray<Ast> =>
	Arr.flatMap(conditions, (child) => {
		const simple = simplifyIn(child, memo)
		return simple._tag === tag && !hasPredicateIn(simple, memo.predicates)
			? simple.conditions
			: [simple]
	})

/**
 * Gives the result of an `And` with a `False` child, or of an `Or` with a
 * `True` child. The children are tested in order, so a predicate before the
 * constant still runs, and it may fail. When there is such a predicate, the
 * children before the constant stay, so the failure is not lost. The other
 * children stay too, because they decide if the predicate runs.
 */
const shortCircuit = (
	tag: "And" | "Or",
	children: ReadonlyArray<Ast>,
	index: number,
	memo: Memo,
): Ast => {
	const constant = tag === "And" ? never : always
	const neutral = tag === "And" ? "True" : "False"
	const before = Arr.filter(
		Arr.take(children, index),
		(child) => child._tag !== neutral,
	)
	if (!Arr.some(before, (child) => hasPredicateIn(child, memo.predicates))) {
		return constant
	}
	return tag === "And"
		? makeAnd(...before, constant)
		: makeOr(...before, constant)
}

const simplifyIn = (ast: Ast, memo: Memo): Ast =>
	remember(memo.simple, ast, () => {
		const result = simplifyNode(ast, memo)
		// The simple form of a simple node is the node itself.
		memo.simple.set(result, result)
		return result
	})

const simplifyJunction = (
	tag: "And" | "Or",
	conditions: ReadonlyArray<Ast>,
	memo: Memo,
): Ast => {
	const constant = tag === "And" ? "False" : "True"
	const neutral = tag === "And" ? "True" : "False"
	const flat = flatten(tag, conditions, memo)
	return Option.match(
		Arr.findFirstIndex(flat, (child) => child._tag === constant),
		{
			onSome: (stop) => shortCircuit(tag, flat, stop, memo),
			onNone: () => {
				const unique = reduce(
					tag === "And" ? "Or" : "And",
					Arr.filter(flat, (child) => child._tag !== neutral),
					memo,
				)
				return unique.length === 0
					? tag === "And"
						? always
						: never
					: unique.length === 1
						? unique[0]!
						: tag === "And"
							? makeAnd(...unique)
							: makeOr(...unique)
			},
		},
	)
}

const simplifyNode = (ast: Ast, memo: Memo): Ast => {
	switch (ast._tag) {
		case "And":
		case "Or":
			return simplifyJunction(ast._tag, ast.conditions, memo)
		case "Not": {
			const child = simplifyIn(ast.condition, memo)
			switch (child._tag) {
				case "True":
					return never
				case "False":
					return always
				case "Not":
					return child.condition
				case "Compare":
					// A principal field with no value makes `eq` and `ne` both false,
					// so only a fixed value lets `not eq` become `ne`.
					if (
						child.value._tag === "Literal" &&
						(child.op === "eq" || child.op === "ne")
					) {
						return nodes.Compare({
							op: child.op === "eq" ? "ne" : "eq",
							field: child.field,
							value: child.value,
						})
					}
					return makeNot(child)
				default:
					return makeNot(child)
			}
		}
		case "In":
			return ast.values.length === 0 ? never : ast
		default:
			return ast
	}
}

const simplifyAst = (ast: Ast): Ast => simplifyIn(ast, makeMemo())

/**
 * Makes a condition smaller without a change to its meaning. It removes `True`
 * and `False` from `And` and `Or`, joins nested `And` and `Or` nodes, and
 * removes double `Not` nodes.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const simplify: <E, R, O, I>(
	condition: Condition<E, R, O, I>,
) => Condition<E, R, O, I> = simplifyAst as never

/**
 * Makes a {@link simplify} function that keeps its work for the parts it has
 * seen. Use one for many calls on conditions that share parts, such as the
 * steps of one residual condition. Do not keep it for long: it keeps every
 * part that it has seen.
 *
 * @stability stable
 * @category evaluation
 * @since 0.4.0
 */
export const simplifier = (): (<E, R, O, I>(
	condition: Condition<E, R, O, I>,
) => Condition<E, R, O, I>) => {
	const memo = makeMemo()
	return ((ast: Ast) => simplifyIn(ast, memo)) as never
}

/**
 * Puts the value of the principal into an operand. It gives `undefined` for a
 * principal field with no value. See {@link resolve}.
 */
const bindOperand = (
	operand: Operand,
	principal: unknown,
): Literal | undefined => {
	if (operand._tag === "Literal") {
		return operand
	}
	const value = resolve(operand, principal)
	return value === undefined ? undefined : literal(value as Scalar)
}

const expandUnder = (
	prefix: ReadonlyArray<Operand>,
	principal: unknown,
	path: ReadonlyArray<Resource.PathSegment> | undefined,
): Ast => {
	if (path === undefined || prefix.length > path.length) {
		return never
	}
	const parts = Arr.map(prefix, (operand, index): Ast => {
		const value = resolve(operand, principal)
		const segment = path[index]!
		return value === undefined
			? never
			: typeof segment === "string"
				? segment === value
					? always
					: never
				: nodes.Compare({
						op: "eq",
						field: segment.field,
						value: literal(value as Scalar),
					})
	})
	return makeAnd(...parts)
}

const bind = (
	ast: Ast,
	principal: unknown,
	path: ReadonlyArray<Resource.PathSegment> | undefined,
	done: Map<Ast, Ast> = new Map(),
): Ast => remember(done, ast, () => bindOnce(ast, principal, path, done))

const bindOnce = (
	ast: Ast,
	principal: unknown,
	path: ReadonlyArray<Resource.PathSegment> | undefined,
	done: Map<Ast, Ast>,
): Ast => {
	switch (ast._tag) {
		case "Compare": {
			const value = bindOperand(ast.value, principal)
			return value === undefined
				? never
				: nodes.Compare({ op: ast.op, field: ast.field, value })
		}
		case "In":
			return nodes.In({
				field: ast.field,
				values: ast.values.flatMap((operand) => {
					const value = bindOperand(operand, principal)
					return value === undefined ? [] : [value]
				}),
			})
		case "Under":
			return expandUnder(ast.prefix, principal, path)
		case "And":
			return makeAnd(
				...ast.conditions.map((child) => bind(child, principal, path, done)),
			)
		case "Or":
			return makeOr(
				...ast.conditions.map((child) => bind(child, principal, path, done)),
			)
		case "Not":
			return makeNot(bind(ast.condition, principal, path, done))
		case "Predicate":
			return makePredicate(ast.name, (value) => ast.run(value, principal))
		default:
			return ast
	}
}

interface PartialInput {
	readonly principal?: object | undefined
	readonly path?: ReadonlyArray<Resource.PathSegment> | undefined
}

/**
 * The principal that {@link partial} must get for the predicates of a
 * condition. A predicate keeps the principal that it gets, so the principal
 * must have the type that the predicate reads.
 */
type PrincipalInput<I> =
	I extends Reads<infer _V, infer P>
		? unknown extends P
			? unknown
			: { readonly principal: P }
		: unknown

/** `unknown` when `In` gives what `I` reads, and `never` when it does not. */
type PrincipalFrom<I, In> = [In] extends [PrincipalInput<I>] ? unknown : never

/** What a condition reads after {@link partial}: the value, and no principal. */
type Bound<I> = I extends Reads<infer V, infer _P> ? Reads<V, unknown> : I

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
	<In extends PartialInput>(
		input: In,
	): <E, R, O, I>(
		condition: Condition<E, R, O, I> & PrincipalFrom<I, In>,
	) => Condition<E, R, O, Bound<I>>
	<E, R, O, I>(
		condition: Condition<E, R, O, I>,
		input: PartialInput & PrincipalInput<I>,
	): Condition<E, R, O, Bound<I>>
} = dual(
	2,
	(
		ast: Ast,
		input: {
			readonly principal?: object | undefined
			readonly path?: ReadonlyArray<Resource.PathSegment> | undefined
		},
	): Ast => simplifyAst(bind(ast, input.principal, input.path)),
)

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
export class Untranslatable extends Schema.TaggedError<Untranslatable>(
	"@nmnmcc/ability/Condition/Untranslatable",
)("Untranslatable", { reason: Schema.String }) {}

const literalValue = (operand: Operand, field: string): Scalar => {
	if (operand._tag !== "Literal") {
		throw Untranslatable.make({
			reason: `The field "${field}" uses a principal field. Call Condition.partial first.`,
		})
	}
	return operand.value
}

const foldAst = <A>(ast: Ast, interpreter: Interpreter<A>): A => {
	switch (ast._tag) {
		case "True":
			return interpreter.true()
		case "False":
			return interpreter.false()
		case "Compare":
			return interpreter.compare(
				ast.op,
				ast.field,
				literalValue(ast.value, ast.field),
			)
		case "In":
			return interpreter.in(
				ast.field,
				ast.values.map((operand) => literalValue(operand, ast.field)),
			)
		case "Exists":
			return interpreter.exists(ast.field)
		case "Under":
			throw Untranslatable.make({
				reason:
					"An Under node needs the resource path. Call Condition.partial first.",
			})
		case "And":
			return interpreter.and(
				ast.conditions.map((child) => foldAst(child, interpreter)),
			)
		case "Or":
			return interpreter.or(
				ast.conditions.map((child) => foldAst(child, interpreter)),
			)
		case "Not":
			return interpreter.not(foldAst(ast.condition, interpreter))
		case "Predicate":
			if (interpreter.predicate === undefined) {
				throw Untranslatable.make({
					reason: `The predicate "${ast.name}" can not become a query`,
				})
			}
			return interpreter.predicate(ast.name)
	}
}

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
} = dual(
	2,
	<A>(
		ast: Ast,
		interpreter: Interpreter<A>,
	): Effect.Effect<A, Untranslatable> =>
		Effect.try({
			try: () => foldAst(ast, interpreter),
			catch: (cause) => {
				if (cause instanceof Untranslatable) {
					return cause
				}
				throw cause
			},
		}),
)

/**
 * The fields that a condition uses.
 *
 * @stability stable
 * @category getters
 * @since 0.3.0
 */
export const fields = (condition: Ast): ReadonlyArray<string> =>
	fieldsIn(condition, new Map())

/**
 * The fields of a node, in the order that they first come. `Arr.union` keeps
 * that order, and a `HashSet` would not.
 */
const fieldsIn = (
	ast: Ast,
	memo: Map<Ast, ReadonlyArray<string>>,
): ReadonlyArray<string> =>
	remember(memo, ast, () => {
		switch (ast._tag) {
			case "Compare":
			case "In":
			case "Exists":
				return [ast.field]
			case "And":
			case "Or":
				return Arr.reduce(ast.conditions, Arr.empty<string>(), (all, child) =>
					Arr.union(all, fieldsIn(child, memo)),
				)
			case "Not":
				return fieldsIn(ast.condition, memo)
			default:
				return []
		}
	})

// Satisfiability

/**
 * Values of fields, as a nested object. A field that is not in it may have any
 * value. A value with parts that the search does not look into, such as a
 * date, is an empty object.
 *
 * @stability stable
 * @category models
 * @since 0.5.0
 */
export interface Example {
	readonly [field: string]: unknown
}

/**
 * The answer of {@link satisfiable}:
 * - `Satisfiable`: some value makes the condition true. `example` is one.
 * - `Unsatisfiable`: no value makes the condition true.
 * - `Unknown`: the search can not say. The condition has a predicate, or the
 *   search went past its budget.
 *
 * @stability stable
 * @category models
 * @since 0.5.0
 */
export type Satisfiability = Data.TaggedEnum<{
	Satisfiable: { readonly example: Example }
	Unsatisfiable: {}
	Unknown: { readonly reason: "predicate" | "budget" }
}>

const satisfiability = Data.taggedEnum<Satisfiability>()

/**
 * The options of {@link satisfiable}.
 *
 * @stability stable
 * @category models
 * @since 0.5.0
 */
export interface SatisfiableOptions {
	/**
	 * The Schema of the values. It gives the domain of each field. Without
	 * it, a field may have any value.
	 */
	readonly schema?: Schema.Top | undefined
	/** The most nodes that the search may visit. The default is 1000000. */
	readonly budget?: number | undefined
}

/** Stands for a value with parts, such as a struct or a date. */
const opaque: object = Object.freeze({})

/** Marks a field that a step of the search did not fix. */
const free: unique symbol = Symbol("free")

const sameValue = (left: unknown, right: unknown): boolean =>
	left === right || (Number.isNaN(left) && Number.isNaN(right))

/** The least number that is greater than `value`. */
const nextUp = (value: number): number => {
	if (Number.isNaN(value) || value === Infinity) {
		return value
	}
	if (value === 0) {
		return Number.MIN_VALUE
	}
	const view = new DataView(new ArrayBuffer(8))
	view.setFloat64(0, value)
	const bits = view.getBigUint64(0)
	view.setBigUint64(0, value > 0 ? bits + 1n : bits - 1n)
	return view.getFloat64(0)
}

/**
 * Gives one number from each part of the number line that the constants
 * make: each constant, and one number between each two neighbours when there
 * is one. The ends of the domain are in the list too.
 */
const numberCells = (
	kind: "integer" | "finite" | "any",
	constants: ReadonlyArray<number>,
): ReadonlyArray<number> => {
	const integer = kind === "integer"
	const low = integer
		? Number.MIN_SAFE_INTEGER
		: kind === "finite"
			? -Number.MAX_VALUE
			: -Infinity
	const high = integer
		? Number.MAX_SAFE_INTEGER
		: kind === "finite"
			? Number.MAX_VALUE
			: Infinity
	const known: ReadonlyArray<number> = Arr.filter(
		constants,
		(value: number) => !Number.isNaN(value),
	)
	const points = Arr.filter(
		Arr.flatMap(known, (value: number) =>
			integer && Number.isFinite(value)
				? [Math.floor(value), Math.ceil(value)]
				: [value],
		),
		(value: number) => value >= low && value <= high,
	)
	// `0` and `-0` are one point: every test gives the same answer for both,
	// and `===` calls them equal.
	const ordered: Array<number> = [low, high, ...points].sort((a, b) => a - b)
	const sorted = Arr.dedupeAdjacentWith(
		ordered,
		(a: number, b: number) => a === b,
	)
	const cells = Arr.flatMap(sorted, (value, index) => {
		const after = sorted[index + 1]
		const between = integer ? value + 1 : nextUp(value)
		return after !== undefined && between < after ? [value, between] : [value]
	})
	return kind === "any" ? Arr.append(cells, Number.NaN) : cells
}

/**
 * Gives one string from each part that the constants make. Strings are in the
 * order of their UTF-16 code units, as `<` sees them. The least string after
 * `a` is `a + "\0"`, so there is a string between `a` and `b` exactly when
 * `b` is not `a + "\0"`.
 */
const stringCells = (
	constants: ReadonlyArray<string>,
): ReadonlyArray<string> => {
	const ordered: Array<string> = [...constants].sort()
	const sorted = Arr.dedupeAdjacentWith(
		ordered,
		(a: string, b: string) => a === b,
	)
	if (sorted.length === 0) {
		return [""]
	}
	return [
		...(sorted[0] === "" ? [] : [""]),
		...Arr.flatMap(sorted, (value, index) => {
			const next = `${value}\0`
			return next === sorted[index + 1] ? [value] : [value, next]
		}),
	]
}

/**
 * Gives one value from each cell of a field. Each test of a field compares it
 * with constants, so the constants cut the domain into a few cells, and every
 * test gives the same answer for all the values of one cell.
 */
const cellsOf = (
	domain: Resource.FieldDomain,
	constants: ReadonlyArray<Scalar>,
): ReadonlyArray<unknown> =>
	Arr.dedupeWith(
		[
			...(domain.null ? [null] : []),
			...(domain.object ? [opaque] : []),
			...(domain.boolean ? [true, false] : []),
			...(domain.string
				? stringCells(
						Arr.filter(constants, (value) => typeof value === "string"),
					)
				: []),
			...(domain.number === "none"
				? []
				: numberCells(
						domain.number,
						Arr.filter(constants, (value) => typeof value === "number"),
					)),
			...domain.literals,
		] as ReadonlyArray<unknown>,
		sameValue,
	)

class OutOfBudget {}

/** What one search keeps for all its steps. It lives only as long as the search. */
interface Search {
	/** The memo of the simplification and of the numbers of structures. */
	readonly memo: Memo
	readonly cells: (field: string) => ReadonlyArray<unknown>
	readonly budget: number
}

/** What a search has done up to now. Each step gives a new one. */
interface SearchState {
	readonly steps: number
	/** The numbers of the conditions that the search found to be unsatisfiable. */
	readonly failed: HashSet.HashSet<number>
}

interface Found {
	readonly assignment: Option.Option<ReadonlyArray<readonly [string, unknown]>>
	readonly state: SearchState
}

const literalOf = (operand: Operand): Scalar => {
	if (operand._tag !== "Literal") {
		throw new Error(
			"Condition.satisfiable needs a condition with no principal fields. Call Condition.partial first.",
		)
	}
	return operand.value
}

/**
 * The value of the field `name` after `field` gets `value`. A field below
 * `field` is `null` when `value` is not a value with parts.
 */
const fixedValue = (
	name: string,
	field: string,
	value: unknown,
): unknown | typeof free =>
	name === field
		? value
		: name.startsWith(`${field}.`)
			? value === opaque
				? free
				: null
			: free

const testFixed = (ast: Compare | In | Exists, value: unknown): boolean => {
	switch (ast._tag) {
		case "Compare":
			return testCompare(ast.op, value, literalOf(ast.value))
		case "In":
			return Arr.some(ast.values, (operand) => literalOf(operand) === value)
		case "Exists":
			return value !== null
	}
}

/**
 * Puts one value into a field, and into the fields below it. The memo has a
 * node for each node that the step visits, so its size is the work of the
 * step.
 */
const fix = (
	ast: Ast,
	field: string,
	value: unknown,
	done: Map<Ast, Ast>,
): Ast =>
	remember(done, ast, () => {
		const fixChild = (child: Ast) => fix(child, field, value, done)
		switch (ast._tag) {
			case "Compare":
			case "In":
			case "Exists": {
				const known = fixedValue(ast.field, field, value)
				return known === free ? ast : testFixed(ast, known) ? always : never
			}
			case "And":
				return makeAnd(...Arr.map(ast.conditions, fixChild))
			case "Or":
				return makeOr(...Arr.map(ast.conditions, fixChild))
			case "Not":
				return makeNot(fixChild(ast.condition))
			default:
				return ast
		}
	})

/** The number of tests of each field, in the order that the fields come. */
type FieldCounts = ReadonlyArray<readonly [string, number]>

const addCounts = (left: FieldCounts, right: FieldCounts): FieldCounts =>
	Arr.reduce(right, left, (all, [field, count]) =>
		Option.match(
			Arr.findFirstIndex(all, ([name]) => name === field),
			{
				onNone: () => Arr.append(all, [field, count] as const),
				onSome: (index) =>
					Arr.map(all, (entry, at) =>
						at === index ? ([entry[0], entry[1] + count] as const) : entry,
					),
			},
		),
	)

const fieldCounts = (ast: Ast, memo: Map<Ast, FieldCounts>): FieldCounts =>
	remember(memo, ast, (): FieldCounts => {
		switch (ast._tag) {
			case "Compare":
			case "In":
			case "Exists":
				return [[ast.field, 1]]
			case "And":
			case "Or":
				return Arr.reduce(ast.conditions, [] as FieldCounts, (all, child) =>
					addCounts(all, fieldCounts(child, memo)),
				)
			case "Not":
				return fieldCounts(ast.condition, memo)
			default:
				return []
		}
	})

/**
 * Picks the next field to split on. A field comes before the fields below it,
 * so a value of a field can fix them. Then a field in more tests comes first.
 */
const nextField = (ast: Ast): string => {
	const depth = (field: string) => field.split(".").length
	const [first, ...rest] = fieldCounts(ast, new Map())
	return Arr.reduce(rest, first!, (best, next) =>
		depth(next[0]) < depth(best[0]) ||
		(depth(next[0]) === depth(best[0]) && next[1] > best[1])
			? next
			: best,
	)[0]
}

/**
 * Finds values of the fields that make the condition true. It splits on one
 * field at a time, and tries one value from each cell of the field.
 */
const searchAst = (
	ast: Ast,
	search: Search,
	state: SearchState,
	assignment: ReadonlyArray<readonly [string, unknown]>,
): Found => {
	const current = simplifyIn(ast, search.memo)
	if (current._tag === "True") {
		return { assignment: Option.some(assignment), state }
	}
	if (current._tag === "False") {
		return { assignment: Option.none(), state }
	}
	// A condition with the same structure has the same free fields, so its
	// answer is the same.
	const id = structureId(current, search.memo)
	if (HashSet.has(state.failed, id)) {
		return { assignment: Option.none(), state }
	}
	const field = nextField(current)
	const cells = search.cells(field)
	// The cells are tried in order, until one gives values.
	const tryCell = (index: number, before: SearchState): Found => {
		if (index === cells.length) {
			return {
				assignment: Option.none(),
				state: { ...before, failed: HashSet.add(before.failed, id) },
			}
		}
		const cell = cells[index]
		const done = new Map<Ast, Ast>()
		const fixed = fix(current, field, cell, done)
		const steps = before.steps + done.size
		if (steps > search.budget) {
			throw new OutOfBudget()
		}
		const found = searchAst(fixed, search, { ...before, steps }, [
			...assignment,
			[field, cell],
		])
		return Option.isSome(found.assignment)
			? found
			: tryCell(index + 1, found.state)
	}
	return tryCell(0, state)
}

/**
 * Puts a value at a path in an object, and gives a new object. A value with
 * parts (`opaque`) becomes an empty object, and it keeps an object that is
 * there.
 */
const setPath = (
	root: Readonly<Record<string, unknown>>,
	names: ReadonlyArray<string>,
	value: unknown,
): Readonly<Record<string, unknown>> => {
	const [name, ...rest] = names
	if (name === undefined) {
		return root
	}
	const inner = root[name]
	if (rest.length === 0) {
		return value === opaque && isObject(inner)
			? root
			: { ...root, [name]: value === opaque ? {} : value }
	}
	const base =
		isObject(inner) && inner !== opaque
			? (inner as Readonly<Record<string, unknown>>)
			: {}
	return { ...root, [name]: setPath(base, rest, value) }
}

const exampleOf = (
	assignment: ReadonlyArray<readonly [string, unknown]>,
): Example =>
	Arr.reduce(
		assignment,
		{} as Readonly<Record<string, unknown>>,
		(root, [field, value]) => setPath(root, field.split("."), value),
	)

/** The constants that the tests of each field use. */
type FieldConstants = HashMap.HashMap<string, ReadonlyArray<Scalar>>

const addConstants = (
	left: FieldConstants,
	right: FieldConstants,
): FieldConstants =>
	HashMap.reduce(right, left, (all, values, field) =>
		HashMap.set(
			all,
			field,
			Arr.appendAll(
				Option.getOrElse(HashMap.get(all, field), Arr.empty),
				values,
			),
		),
	)

const constantsOf = (
	ast: Ast,
	memo: Map<Ast, FieldConstants> = new Map(),
): FieldConstants =>
	remember(memo, ast, (): FieldConstants => {
		switch (ast._tag) {
			case "Compare":
				return HashMap.make([ast.field, [literalOf(ast.value)]])
			case "In":
				return HashMap.make([ast.field, Arr.map(ast.values, literalOf)])
			case "Exists":
				return HashMap.make([ast.field, Arr.empty<Scalar>()])
			case "Under":
				throw new Error(
					"Condition.satisfiable needs a condition with no Under nodes. Call Condition.partial first.",
				)
			case "And":
			case "Or":
				return Arr.reduce(ast.conditions, HashMap.empty(), (all, child) =>
					addConstants(all, constantsOf(child, memo)),
				)
			case "Not":
				return constantsOf(ast.condition, memo)
			default:
				return HashMap.empty()
		}
	})

const satisfiableAst = (
	ast: Ast,
	options: SatisfiableOptions = {},
): Satisfiability => {
	if (hasPredicate(ast)) {
		return satisfiability.Unknown({ reason: "predicate" })
	}
	const constants = constantsOf(ast)
	const schema = options.schema
	// The cells of each field. A field name is a string, so an Effect map
	// finds it.
	const cells = MutableHashMap.empty<string, ReadonlyArray<unknown>>()
	const search: Search = {
		memo: makeMemo(),
		cells: (field) =>
			Option.getOrElse(MutableHashMap.get(cells, field), () => {
				const found = cellsOf(
					schema === undefined
						? Resource.anyDomain
						: Resource.domainOf(schema, field),
					Option.getOrElse(HashMap.get(constants, field), Arr.empty),
				)
				MutableHashMap.set(cells, field, found)
				return found
			}),
		budget: options.budget ?? 1_000_000,
	}
	try {
		const found = searchAst(
			ast,
			search,
			{ steps: 0, failed: HashSet.empty() },
			[],
		)
		return Option.match(found.assignment, {
			onNone: () => satisfiability.Unsatisfiable(),
			onSome: (assignment) =>
				satisfiability.Satisfiable({ example: exampleOf(assignment) }),
		})
	} catch (error) {
		if (error instanceof OutOfBudget) {
			return satisfiability.Unknown({ reason: "budget" })
		}
		throw error
	}
}

/**
 * Tests if some value makes a condition true, and gives such a value.
 *
 * Call {@link partial} first: the condition must have no principal fields and
 * no `Under` nodes. A condition with a predicate gives `Unknown`.
 *
 * The answer is exact. Each test of a condition compares one field with
 * constants, so the constants cut the values of each field into a few cells.
 * The search tries one value from each cell, one field at a time. The values
 * of a field come from the Schema in `options.schema`: its literals, `null`
 * for a nullable or optional field, and finite or integer numbers. Other
 * Schema checks are left out, so the search may try a value that such a check
 * stops. Then `Satisfiable` may be the answer where the check makes it
 * `Unsatisfiable`, never the other way.
 *
 * The problem is as hard as boolean satisfiability, so the search has a
 * budget. Past it, the answer is `Unknown`.
 *
 * @stability stable
 * @category evaluation
 * @since 0.5.0
 */
export const satisfiable: {
	(options?: SatisfiableOptions): (condition: Any) => Satisfiability
	(condition: Any, options?: SatisfiableOptions): Satisfiability
} = dual(
	(args) => isObject(args[0]) && hasProperty(args[0], "_tag"),
	satisfiableAst,
) as never

const operandJson = (operand: Operand): unknown =>
	operand._tag === "Literal" &&
	typeof operand.value === "number" &&
	!Number.isFinite(operand.value)
		? { ...operand, value: { nonFinite: String(operand.value) } }
		: operand

const jsonIn = (ast: Ast, done: Map<Ast, unknown>): unknown =>
	remember(done, ast, (): unknown => {
		switch (ast._tag) {
			case "Compare":
				return { ...ast, value: operandJson(ast.value) }
			case "In":
				return { ...ast, values: Arr.map(ast.values, operandJson) }
			case "Under":
				return { ...ast, prefix: Arr.map(ast.prefix, operandJson) }
			case "And":
			case "Or":
				return {
					...ast,
					conditions: Arr.map(ast.conditions, (child) => jsonIn(child, done)),
				}
			case "Not":
				return { ...ast, condition: jsonIn(ast.condition, done) }
			default:
				return ast
		}
	})

/**
 * Gives a condition as a value that `JSON.stringify` keeps with no loss. JSON
 * has no `Infinity`, `-Infinity` or `NaN`: it writes `null` in their place,
 * and a test with `null` has another meaning. Such a number becomes an object
 * that {@link schema} does not decode, so a policy with it fails to load and
 * never gives a wrong answer.
 *
 * @stability stable
 * @category conversions
 * @since 0.5.0
 */
export const toJsonValue = (condition: Ast): unknown =>
	jsonIn(condition, new Map())

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

const ScalarSchema = Schema.Union([
	Schema.String,
	Schema.Finite,
	Schema.Boolean,
	Schema.Null,
])

const OperandSchema = Schema.Union([
	Schema.TaggedStruct("Literal", { value: ScalarSchema }),
	Schema.TaggedStruct("Principal", { path: Schema.String }),
])

const Recursive = Schema.suspend((): Schema.Codec<Condition, Encoded> => schema)

/**
 * The Schema of a condition with no predicate. It checks the shape only. Use
 * `Policy.schema` to check the field names against a domain too.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export const schema: Schema.Codec<Condition, Encoded> = Schema.Union([
	Schema.TaggedStruct("True", {}),
	Schema.TaggedStruct("False", {}),
	Schema.TaggedStruct("Compare", {
		op: Schema.Literals(["eq", "ne", "lt", "lte", "gt", "gte"]),
		field: Schema.String,
		value: OperandSchema,
	}),
	Schema.TaggedStruct("In", {
		field: Schema.String,
		values: Schema.Array(OperandSchema),
	}),
	Schema.TaggedStruct("Exists", { field: Schema.String }),
	Schema.TaggedStruct("Under", { prefix: Schema.Array(OperandSchema) }),
	Schema.TaggedStruct("And", { conditions: Schema.Array(Recursive) }),
	Schema.TaggedStruct("Or", { conditions: Schema.Array(Recursive) }),
	Schema.TaggedStruct("Not", { condition: Recursive }),
]) as never
