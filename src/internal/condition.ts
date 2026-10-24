// A predicate keeps its error type and service type only in the public types.
// Inside this file they are erased to `unknown`, so the language service check
// for `unknown` in an Effect is off here.
// @effect-diagnostics anyUnknownInErrorContext:off
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import { dual } from "effect/Function"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type * as Condition from "../Condition.ts"
import type * as Resource from "../Resource.ts"

type Ast = Condition.Ast
type Scalar = Condition.Scalar

/** @internal */
export const always: Condition.True = Object.freeze({ _tag: "True" })

/** @internal */
export const never: Condition.False = Object.freeze({ _tag: "False" })

const literal = (value: Scalar): Condition.Literal =>
	Object.freeze({ _tag: "Literal", value })

const isOperand = (u: unknown): u is Condition.Operand =>
	Predicate.hasProperty(u, "_tag") &&
	(u._tag === "Literal" || u._tag === "Principal")

const toOperand = (value: unknown): Condition.Operand =>
	isOperand(value) ? value : literal(value as Scalar)

const compare =
	(op: Condition.CompareOperator) =>
	(field: string, value: unknown): Condition.Compare =>
		Object.freeze({ _tag: "Compare", op, field, value: toOperand(value) })

/** @internal */
export const and = (...conditions: ReadonlyArray<Ast>): Condition.And =>
	Object.freeze({ _tag: "And", conditions: Object.freeze([...conditions]) })

/** @internal */
export const or = (...conditions: ReadonlyArray<Ast>): Condition.Or =>
	Object.freeze({ _tag: "Or", conditions: Object.freeze([...conditions]) })

/** @internal */
export const not = (condition: Ast): Condition.Not =>
	Object.freeze({ _tag: "Not", condition })

/** @internal */
export const builder = (): any =>
	Object.freeze({
		eq: compare("eq"),
		ne: compare("ne"),
		lt: compare("lt"),
		lte: compare("lte"),
		gt: compare("gt"),
		gte: compare("gte"),
		in: (field: string, values: ReadonlyArray<unknown>): Condition.In =>
			Object.freeze({
				_tag: "In",
				field,
				values: Object.freeze(values.map(toOperand)),
			}),
		exists: (field: string): Condition.Exists =>
			Object.freeze({ _tag: "Exists", field }),
		under: (...prefix: ReadonlyArray<unknown>): Condition.Under =>
			Object.freeze({
				_tag: "Under",
				prefix: Object.freeze(prefix.map(toOperand)),
			}),
		principal: (path: string): Condition.PrincipalRef =>
			Object.freeze({ _tag: "Principal", path }),
		and,
		or,
		not,
		predicate: (
			name: string,
			test: (
				value: unknown,
				principal: unknown,
			) => boolean | Effect.Effect<boolean, unknown, unknown>,
		): Condition.Predicate =>
			Object.freeze({
				_tag: "Predicate",
				name,
				run: (value: unknown, principal: unknown) =>
					Effect.suspend(() => {
						const result = test(value, principal)
						return Effect.isEffect(result) ? result : Effect.succeed(result)
					}),
			}),
	})

/**
 * Gets a field of an object by a path with dots. A missing field, or a field
 * under a value that is not an object, gives `null`.
 *
 * @internal
 */
export const getField = (value: unknown, path: string): unknown => {
	let cursor: unknown = value
	for (const key of path.split(".")) {
		if (!Predicate.isObject(cursor) || !Object.hasOwn(cursor, key)) {
			return null
		}
		cursor = (cursor as Record<string, unknown>)[key]
	}
	return cursor === undefined ? null : cursor
}

/**
 * Gives the value of an operand. A principal field that is `null` or missing
 * gives `undefined`. No field of a resource is `undefined`, so a test with it
 * is never true. This keeps the check closed: a principal with no id never
 * matches a resource with no owner.
 */
const resolve = (operand: Condition.Operand, principal: unknown): unknown =>
	operand._tag === "Literal"
		? operand.value
		: (getField(principal, operand.path) ?? undefined)

const testCompare = (
	op: Condition.CompareOperator,
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

const testUnder = (
	prefix: ReadonlyArray<Condition.Operand>,
	input: Condition.Input,
): boolean => {
	const values = pathValues(input.value, input.path)
	if (values === undefined || prefix.length > values.length) {
		return false
	}
	return prefix.every(
		(operand, index) => resolve(operand, input.principal) === values[index],
	)
}

/** @internal */
export const hasPredicate = (ast: Ast): boolean => {
	switch (ast._tag) {
		case "Predicate":
			return true
		case "And":
		case "Or":
			return ast.conditions.some(hasPredicate)
		case "Not":
			return hasPredicate(ast.condition)
		default:
			return false
	}
}

/** @internal */
export const evaluateSyncOf = (ast: Ast, input: Condition.Input): boolean => {
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
			return ast.conditions.every((child) => evaluateSyncOf(child, input))
		case "Or":
			return ast.conditions.some((child) => evaluateSyncOf(child, input))
		case "Not":
			return !evaluateSyncOf(ast.condition, input)
		case "Predicate":
			// The types stop this. A predicate needs `evaluate`.
			throw new Error(
				`The predicate "${ast.name}" needs an Effect. Use Condition.evaluate.`,
			)
	}
}

/** @internal */
export const evaluateOf = (
	ast: Ast,
	input: Condition.Input,
): Effect.Effect<boolean, unknown, unknown> => {
	if (!hasPredicate(ast)) {
		return Effect.sync(() => evaluateSyncOf(ast, input))
	}
	switch (ast._tag) {
		case "Predicate":
			return ast.run(input.value, input.principal)
		case "Not":
			return Effect.map(evaluateOf(ast.condition, input), (value) => !value)
		case "And":
			return Effect.gen(function* () {
				for (const child of ast.conditions) {
					if (!(yield* evaluateOf(child, input))) {
						return false
					}
				}
				return true
			})
		case "Or":
			return Effect.gen(function* () {
				for (const child of ast.conditions) {
					if (yield* evaluateOf(child, input)) {
						return true
					}
				}
				return false
			})
		default:
			return Effect.sync(() => evaluateSyncOf(ast, input))
	}
}

const dedupe = (conditions: ReadonlyArray<Ast>): ReadonlyArray<Ast> => {
	const output: Array<Ast> = []
	for (const condition of conditions) {
		if (!output.some((other) => Equal.equals(other, condition))) {
			output.push(condition)
		}
	}
	return output
}

/**
 * Removes the children that the other children make useless. In an `Or`,
 * `a OR (a AND b)` is `a`. In an `And`, `a AND (a OR b)` is `a`.
 */
const absorb = (
	inner: "And" | "Or",
	conditions: ReadonlyArray<Ast>,
): ReadonlyArray<Ast> =>
	conditions.filter(
		(condition) =>
			condition._tag !== inner ||
			!conditions.some(
				(other) =>
					other !== condition &&
					condition.conditions.some((part) => Equal.equals(part, other)),
			),
	)

const flatten = (
	tag: "And" | "Or",
	conditions: ReadonlyArray<Ast>,
): ReadonlyArray<Ast> =>
	conditions.flatMap((child) => {
		const simple = simplify(child)
		return simple._tag === tag ? simple.conditions : [simple]
	})

/** @internal */
export const simplify = (ast: Ast): Ast => {
	switch (ast._tag) {
		case "And": {
			const children = flatten("And", ast.conditions).filter(
				(child) => child._tag !== "True",
			)
			if (children.some((child) => child._tag === "False")) {
				return never
			}
			const unique = absorb("Or", dedupe(children))
			if (unique.length === 0) {
				return always
			}
			return unique.length === 1 ? unique[0]! : and(...unique)
		}
		case "Or": {
			const children = flatten("Or", ast.conditions).filter(
				(child) => child._tag !== "False",
			)
			if (children.some((child) => child._tag === "True")) {
				return always
			}
			const unique = absorb("And", dedupe(children))
			if (unique.length === 0) {
				return never
			}
			return unique.length === 1 ? unique[0]! : or(...unique)
		}
		case "Not": {
			const child = simplify(ast.condition)
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
						return Object.freeze({
							...child,
							op: child.op === "eq" ? "ne" : "eq",
						})
					}
					return not(child)
				default:
					return not(child)
			}
		}
		case "In":
			return ast.values.length === 0 ? never : ast
		default:
			return ast
	}
}

/**
 * Puts the value of the principal into an operand. It gives `undefined` for a
 * principal field with no value. See {@link resolve}.
 */
const bindOperand = (
	operand: Condition.Operand,
	principal: unknown,
): Condition.Literal | undefined => {
	if (operand._tag === "Literal") {
		return operand
	}
	const value = resolve(operand, principal)
	return value === undefined ? undefined : literal(value as Scalar)
}

const expandUnder = (
	prefix: ReadonlyArray<Condition.Operand>,
	principal: unknown,
	path: ReadonlyArray<Resource.PathSegment> | undefined,
): Ast => {
	if (path === undefined || prefix.length > path.length) {
		return never
	}
	const parts: Array<Ast> = []
	prefix.forEach((operand, index) => {
		const value = resolve(operand, principal)
		const segment = path[index]!
		if (value === undefined) {
			parts.push(never)
		} else if (typeof segment === "string") {
			parts.push(segment === value ? always : never)
		} else {
			parts.push(
				Object.freeze({
					_tag: "Compare",
					op: "eq",
					field: segment.field,
					value: literal(value as Scalar),
				}),
			)
		}
	})
	return and(...parts)
}

const bind = (
	ast: Ast,
	principal: unknown,
	path: ReadonlyArray<Resource.PathSegment> | undefined,
): Ast => {
	switch (ast._tag) {
		case "Compare": {
			const value = bindOperand(ast.value, principal)
			return value === undefined ? never : Object.freeze({ ...ast, value })
		}
		case "In":
			return Object.freeze({
				...ast,
				values: Object.freeze(
					ast.values.flatMap((operand) => {
						const value = bindOperand(operand, principal)
						return value === undefined ? [] : [value]
					}),
				),
			})
		case "Under":
			return expandUnder(ast.prefix, principal, path)
		case "And":
			return and(...ast.conditions.map((child) => bind(child, principal, path)))
		case "Or":
			return or(...ast.conditions.map((child) => bind(child, principal, path)))
		case "Not":
			return not(bind(ast.condition, principal, path))
		case "Predicate":
			return Object.freeze({
				_tag: "Predicate",
				name: ast.name,
				run: (value: unknown) => ast.run(value, principal),
			})
		default:
			return ast
	}
}

/** @internal */
export const partialOf = (
	ast: Ast,
	input: {
		readonly principal?: object | undefined
		readonly path?: ReadonlyArray<Resource.PathSegment> | undefined
	},
): Ast => simplify(bind(ast, input.principal, input.path))

/** @internal */
export const evaluate = dual(2, evaluateOf)

/** @internal */
export const evaluateSync = dual(2, evaluateSyncOf)

/** @internal */
export const partial = dual(2, partialOf)

/** @internal */
export class Untranslatable extends Schema.TaggedError<Untranslatable>(
	"@nmnmcc/ability/Condition/Untranslatable",
)("Untranslatable", { reason: Schema.String }) {}

const foldNode = <A>(ast: Ast, interpreter: Condition.Interpreter<A>): A => {
	switch (ast._tag) {
		case "True":
			return interpreter.true()
		case "False":
			return interpreter.false()
		case "Compare":
			if (ast.value._tag !== "Literal") {
				throw Untranslatable.make({
					reason: `The field "${ast.field}" is compared with a principal field. Call Condition.partial first.`,
				})
			}
			return interpreter.compare(ast.op, ast.field, ast.value.value)
		case "In":
			return interpreter.in(
				ast.field,
				ast.values.map((operand) => {
					if (operand._tag !== "Literal") {
						throw Untranslatable.make({
							reason: `The field "${ast.field}" uses a principal field. Call Condition.partial first.`,
						})
					}
					return operand.value
				}),
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
				ast.conditions.map((child) => foldNode(child, interpreter)),
			)
		case "Or":
			return interpreter.or(
				ast.conditions.map((child) => foldNode(child, interpreter)),
			)
		case "Not":
			return interpreter.not(foldNode(ast.condition, interpreter))
		case "Predicate":
			if (interpreter.predicate === undefined) {
				throw Untranslatable.make({
					reason: `The predicate "${ast.name}" can not become a query`,
				})
			}
			return interpreter.predicate(ast.name)
	}
}

/** @internal */
export const fold = dual(
	2,
	<A>(
		ast: Ast,
		interpreter: Condition.Interpreter<A>,
	): Effect.Effect<A, Untranslatable> =>
		Effect.try({
			try: () => foldNode(ast, interpreter),
			catch: (cause) => {
				if (cause instanceof Untranslatable) {
					return cause
				}
				throw cause
			},
		}),
)

/** @internal */
export const fields = (ast: Ast): ReadonlyArray<string> => {
	const output = new Set<string>()
	const visit = (node: Ast): void => {
		switch (node._tag) {
			case "Compare":
			case "In":
			case "Exists":
				output.add(node.field)
				return
			case "And":
			case "Or":
				node.conditions.forEach(visit)
				return
			case "Not":
				visit(node.condition)
				return
			default:
				return
		}
	}
	visit(ast)
	return Object.freeze(Array.from(output))
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

const Recursive = Schema.suspend(
	(): Schema.Codec<Condition.Condition, Condition.Encoded> => schema,
)

/** @internal */
export const schema: Schema.Codec<Condition.Condition, Condition.Encoded> =
	Schema.Union([
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
