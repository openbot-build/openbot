/**
 * A resource is a kind of thing that a person may act on, such as a Bot or a
 * document. Each resource has a kind name, a list of actions, a Schema for its
 * data, and an optional path.
 *
 * Make a resource in one of two ways:
 * - {@link Class} makes a Schema class, in the same way as
 *   `Schema.TaggedClass`. The class is a Schema, a constructor, and a resource
 *   at the same time.
 * - {@link make} makes a resource from plain fields. Its values are plain
 *   objects with a `_tag` field.
 *
 * Every value of a resource has a `_tag` field with the kind name. The library
 * uses this field to find the resource of a value. It does not guess from the
 * constructor name.
 *
 * A path puts a resource inside a tree, such as
 * `["org", organizationId, "user", ownerUserId, "bot", id]`. A condition can
 * then ask if a value is under a part of the tree. See `Condition.under`.
 *
 * @stability stable
 * @since 0.3.0
 */
import * as Arr from "effect/Array"
import { Class as DataClass } from "effect/Data"
import * as HashSet from "effect/HashSet"
import { hasProperty } from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"

/**
 * One part of a resource path. A string is a fixed part. A field reference
 * takes the part from a field of the value.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type PathSegment = string | FieldRef<string>

/**
 * A reference to a top-level field of a resource, used in a path.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface FieldRef<Name extends string> {
	readonly _tag: "Field"
	readonly field: Name
}

/**
 * The runtime data of a resource.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Descriptor {
	readonly kind: string
	readonly actions: ReadonlyArray<string>
	readonly path: ReadonlyArray<PathSegment> | undefined
	/** The paths of the data fields, with dots for nested fields. */
	readonly fieldPaths: ReadonlyArray<string>
	/**
	 * The paths in {@link fieldPaths} of fields that hold more than one value,
	 * such as a record, a map or an array. The parts of such a field are not
	 * in `fieldPaths`, but a rule may name them.
	 */
	readonly openPaths: ReadonlyArray<string>
	/**
	 * A struct Schema of the data of the values, with the `_tag` field. It is a
	 * struct also for a `Resource.Class`. The class Schema must not be read
	 * before the class is made, because Effect then binds the class Schema to
	 * the base class, and the values lose the getters of the class.
	 */
	readonly schema: Schema.Top
}

/**
 * A resource. `Kind` is its name, `Action` is the union of its actions, `Data`
 * is the type of its Schema fields, and `Value` is the type of its values.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Resource<
	Kind extends string,
	Action extends string,
	Data extends object,
	Value extends { readonly _tag: Kind },
> {
	readonly descriptor: Descriptor
	readonly "~Resource"?: {
		readonly Kind: Kind
		readonly Action: Action
		readonly Data: Data
		readonly Value: Value
	}
}

/**
 * Any resource.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Any = Resource<string, string, object, { readonly _tag: string }>

/**
 * The kind name of a resource.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Kind<R> = R extends Resource<infer K, any, any, any> ? K : never

/**
 * The actions of a resource.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Action<R> = R extends Resource<any, infer A, any, any> ? A : never

/**
 * The type of the Schema fields of a resource, without `_tag`.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Data<R> = R extends Resource<any, any, infer D, any> ? D : never

/**
 * The type of the values of a resource.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Value<R> = R extends Resource<any, any, any, infer V> ? V : never

/**
 * The options of a resource.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Options<
	Actions extends ReadonlyArray<string>,
	Fields extends Schema.Struct.Fields,
> {
	readonly actions: Actions
	readonly fields: Fields
	/**
	 * Gives the path of the resource. The function gets one reference for each
	 * top-level field.
	 */
	readonly path?: (fields: {
		readonly [K in keyof Fields & string]: FieldRef<K>
	}) => ReadonlyArray<PathSegment>
}

/**
 * The class of the runtime data of a resource. {@link isResource} uses it to
 * know a resource.
 */
class ResourceDescriptor extends DataClass<Descriptor> {}

/**
 * Gives the struct of a `Schema.Class`. A class is a declaration with one
 * struct as its type parameter, and Effect marks it with a `"~constructor"`
 * annotation, also through more codec steps, as in
 * `Schema.fromJsonString(User)`. Other declarations, such as
 * `Schema.OptionFromNullOr` or `Schema.ReadonlyMap`, have no such mark, and
 * the fields of their type parameter are not fields of the value.
 */
const classStruct = (
	ast: SchemaAST.Declaration,
): SchemaAST.Objects | undefined => {
	const [inner] = ast.typeParameters
	return ast.annotations?.["~constructor"] !== undefined &&
		ast.typeParameters.length === 1 &&
		inner?._tag === "Objects"
		? inner
		: undefined
}

/**
 * Gives the structs inside a Schema, with the `Schema.suspend` nodes that are
 * open on the way to each one. The open nodes are in a native `Set`, because
 * it must find a node by the node itself: `Equal` compares Schema nodes by
 * structure, and a recursive Schema has no end. It looks through optional keys, unions such as
 * `Schema.NullOr`, `Schema.suspend`, and `Schema.Class`. A suspend node that
 * is already open is not opened again, so a recursive Schema has an end.
 */
const structsOf = (
	ast: SchemaAST.AST,
	open: ReadonlySet<SchemaAST.AST>,
): ReadonlyArray<readonly [SchemaAST.Objects, ReadonlySet<SchemaAST.AST>]> => {
	switch (ast._tag) {
		case "Objects":
			return ast.propertySignatures.length === 0 ? [] : [[ast, open]]
		case "Union":
			return ast.types.flatMap((type) => structsOf(type, open))
		case "Suspend":
			return open.has(ast)
				? []
				: structsOf(ast.thunk(), new Set([...open, ast]))
		case "Declaration": {
			const inner = classStruct(ast)
			return inner === undefined ? [] : structsOf(inner, open)
		}
		default:
			return []
	}
}

/** Tests if a Schema holds one plain value, with no parts. */
/**
 * The kind of value that a field holds: one plain value, a record with keys
 * that the Schema does not name, or another value with parts, such as an
 * array or a map.
 */
type FieldShape = "scalar" | "record" | "other"

/** Gives the kind of value that a field holds. See {@link FieldShape}. */
const shapeOf = (
	ast: SchemaAST.AST,
	open: ReadonlySet<SchemaAST.AST> = new Set(),
): FieldShape => {
	switch (ast._tag) {
		case "Objects":
			return ast.indexSignatures.length > 0 ? "record" : "other"
		case "Union": {
			const shapes = ast.types.map((type) => shapeOf(type, open))
			return shapes.every((shape) => shape === "scalar")
				? "scalar"
				: shapes.includes("record")
					? "record"
					: "other"
		}
		case "Suspend":
			return open.has(ast)
				? "other"
				: shapeOf(ast.thunk(), new Set([...open, ast]))
		default:
			return isScalar(ast) ? "scalar" : "other"
	}
}

const isScalar = (ast: SchemaAST.AST): boolean => {
	switch (ast._tag) {
		case "String":
		case "Number":
		case "Boolean":
		case "BigInt":
		case "Symbol":
		case "UniqueSymbol":
		case "Literal":
		case "Enum":
		case "TemplateLiteral":
		case "Null":
		case "Undefined":
			return true
		default:
			return false
	}
}

/**
 * Tests if a Schema holds, in some branch, a value that is not a struct: a
 * scalar, or a value such as a record or an array.
 */
const holdsValue = (
	ast: SchemaAST.AST,
	open: ReadonlySet<SchemaAST.AST>,
): boolean => {
	switch (ast._tag) {
		case "Objects":
			return ast.propertySignatures.length === 0
		case "Union":
			return ast.types.some((type) => holdsValue(type, open))
		case "Suspend":
			return !open.has(ast) && holdsValue(ast.thunk(), new Set([...open, ast]))
		case "Declaration":
			return classStruct(ast) === undefined
		default:
			return true
	}
}

/** One field that {@link walkFields} finds. */
interface FieldVisit {
	readonly path: string
	/**
	 * `true` for a field that holds a value that is not a struct, and `false`
	 * for a field that holds a struct.
	 */
	readonly leaf: boolean
	readonly type: SchemaAST.AST
}

/**
 * Gives the path of every field of a Schema, with a dot between the names of
 * nested fields. A field of a union may come two times: one time as a field
 * that holds a value, and one time as a field that holds a struct.
 */
const walkFields = (
	ast: SchemaAST.AST,
	prefix = "",
	open: ReadonlySet<SchemaAST.AST> = new Set(),
): ReadonlyArray<FieldVisit> =>
	Arr.flatMap(structsOf(ast, open), ([struct, inner]) =>
		Arr.flatMap(struct.propertySignatures, (property): Array<FieldVisit> => {
			const name = property.name
			if (typeof name !== "string") {
				return []
			}
			// A dot in a path is the step into a nested field. A field name with a
			// dot would make two fields have one path, so it is a defect.
			if (name.includes(".")) {
				throw new Error(`A field name may not have a dot: "${name}"`)
			}
			// An empty name would make an empty part in a path, such as `.secret`.
			if (name === "") {
				throw new Error("A field name may not be empty")
			}
			const path = prefix === "" ? name : `${prefix}.${name}`
			const type = property.type
			return [
				...(holdsValue(type, inner) ? [{ path, leaf: true, type }] : []),
				...(structsOf(type, inner).length > 0
					? [{ path, leaf: false, type }, ...walkFields(type, path, inner)]
					: []),
			]
		}),
	)

/**
 * Gives the paths of all the fields of a Schema, with dots for nested fields.
 * A nested struct gives its own path and the paths of its fields. Arrays are
 * left out. It throws when a field name has a dot or is empty, because such a
 * name would give two fields one path, or a path with an empty part.
 *
 * @stability stable
 * @category getters
 * @since 0.4.0
 */
export const fieldPaths = (schema: Schema.Top): ReadonlyArray<string> =>
	Arr.dedupe(Arr.map(walkFields(schema.ast), (visit) => visit.path))

/**
 * Tests if a path names a field of a Schema that holds a value with no named
 * fields: a scalar, or a value such as a record or an array. It goes into
 * records by their keys, and into recursive Schemas as far as the path goes.
 * So it finds paths that {@link fieldPaths} does not list.
 *
 * @stability stable
 * @category predicates
 * @since 0.4.0
 */
export const hasPath = (schema: Schema.Top, path: string): boolean =>
	resolves(schema.ast, path.split("."), 0, new Set())

const resolves = (
	ast: SchemaAST.AST,
	names: ReadonlyArray<string>,
	index: number,
	open: ReadonlySet<SchemaAST.AST>,
): boolean => {
	if (index === names.length) {
		return index > 0 && holdsValue(ast, new Set())
	}
	const name = names[index]!
	switch (ast._tag) {
		case "Objects": {
			const property = ast.propertySignatures.find(
				(signature) => signature.name === name,
			)
			if (property !== undefined) {
				return resolves(property.type, names, index + 1, new Set())
			}
			// A key of a record must fit the Schema of the keys.
			return ast.indexSignatures.some(
				(signature) =>
					Schema.is(Schema.make(signature.parameter))(name) &&
					resolves(signature.type, names, index + 1, new Set()),
			)
		}
		case "Union":
			return ast.types.some((type) => resolves(type, names, index, open))
		case "Suspend":
			// A suspend node that gives itself again, with no step on the path,
			// has no end.
			return (
				!open.has(ast) &&
				resolves(ast.thunk(), names, index, new Set([...open, ast]))
			)
		case "Declaration": {
			const inner = classStruct(ast)
			return inner !== undefined && resolves(inner, names, index, open)
		}
		default:
			return false
	}
}

/**
 * The values that one field of a resource may hold, as a condition sees them.
 * A missing field and `undefined` are `null`. The domain may be larger than
 * the real set of values: Schema checks other than finite and integer checks
 * are left out. A larger domain only makes a check say "no" more often.
 *
 * @stability stable
 * @category models
 * @since 0.5.0
 */
export interface FieldDomain {
	/** The field may be `null` or missing. */
	readonly null: boolean
	/** The field may hold a value with parts, or a value that is not a scalar. */
	readonly object: boolean
	/** The field may hold `true` and `false`. */
	readonly boolean: boolean
	/** The field may hold any string. */
	readonly string: boolean
	/** The numbers that the field may hold. */
	readonly number: "none" | "integer" | "finite" | "any"
	/** Single values that the field may hold, other than the ones above. */
	readonly literals: ReadonlyArray<string | number | boolean>
}

const numberOrder = ["none", "integer", "finite", "any"] as const

const emptyDomain: FieldDomain = {
	null: false,
	object: false,
	boolean: false,
	string: false,
	number: "none",
	literals: [],
}

const nullDomain: FieldDomain = { ...emptyDomain, null: true }

const objectDomain: FieldDomain = { ...emptyDomain, object: true }

/**
 * The domain of a field with no Schema: any value.
 *
 * @stability stable
 * @category constants
 * @since 0.5.0
 */
export const anyDomain: FieldDomain = {
	null: true,
	object: true,
	boolean: true,
	string: true,
	number: "any",
	literals: [],
}

const joinDomains = (domains: ReadonlyArray<FieldDomain>): FieldDomain =>
	domains.reduce(
		(left, right) => ({
			null: left.null || right.null,
			object: left.object || right.object,
			boolean: left.boolean || right.boolean,
			string: left.string || right.string,
			number:
				numberOrder.indexOf(left.number) >= numberOrder.indexOf(right.number)
					? left.number
					: right.number,
			literals: [...left.literals, ...right.literals],
		}),
		emptyDomain,
	)

const hasCheck = (
	checks: ReadonlyArray<SchemaAST.Check<never>>,
	id: string,
): boolean =>
	checks.some(
		(check) =>
			check.annotations?.representation?.id === id ||
			(check._tag === "FilterGroup" && hasCheck(check.checks, id)),
	)

/** The domain of the values of a Schema node. */
const domainOfType = (
	ast: SchemaAST.AST,
	open: ReadonlySet<SchemaAST.AST>,
): FieldDomain => {
	switch (ast._tag) {
		case "Null":
		case "Undefined":
		case "Void":
			return nullDomain
		case "Never":
			return emptyDomain
		case "Unknown":
		case "Any":
			return anyDomain
		case "String":
		case "TemplateLiteral":
			return { ...emptyDomain, string: true }
		case "Number": {
			const checks = ast.checks ?? []
			return {
				...emptyDomain,
				number: hasCheck(checks, "effect/schema/isInt")
					? "integer"
					: hasCheck(checks, "effect/schema/isFinite")
						? "finite"
						: "any",
			}
		}
		case "Boolean":
			return { ...emptyDomain, boolean: true }
		case "Literal":
			return typeof ast.literal === "bigint"
				? objectDomain
				: { ...emptyDomain, literals: [ast.literal] }
		case "Enum":
			return { ...emptyDomain, literals: ast.enums.map(([, value]) => value) }
		case "Union":
			return joinDomains(ast.types.map((type) => domainOfType(type, open)))
		case "Suspend":
			return open.has(ast)
				? anyDomain
				: domainOfType(ast.thunk(), new Set([...open, ast]))
		default:
			return objectDomain
	}
}

const domainAt = (
	ast: SchemaAST.AST,
	names: ReadonlyArray<string>,
	index: number,
	open: ReadonlySet<SchemaAST.AST>,
): FieldDomain => {
	if (index === names.length) {
		return domainOfType(ast, open)
	}
	const name = names[index]!
	switch (ast._tag) {
		case "Objects": {
			const property = ast.propertySignatures.find(
				(signature) => signature.name === name,
			)
			if (property !== undefined) {
				const inner = domainAt(property.type, names, index + 1, new Set())
				return SchemaAST.isOptional(property.type)
					? joinDomains([nullDomain, inner])
					: inner
			}
			// A key of a record may be missing.
			return joinDomains([
				nullDomain,
				...ast.indexSignatures
					.filter((signature) =>
						Schema.is(Schema.make(signature.parameter))(name),
					)
					.map((signature) =>
						domainAt(signature.type, names, index + 1, new Set()),
					),
			])
		}
		case "Union":
			return joinDomains(
				ast.types.map((type) => domainAt(type, names, index, open)),
			)
		case "Suspend":
			return open.has(ast)
				? anyDomain
				: domainAt(ast.thunk(), names, index, new Set([...open, ast]))
		case "Declaration": {
			const inner = classStruct(ast)
			return inner === undefined
				? anyDomain
				: domainAt(inner, names, index, open)
		}
		case "Arrays":
		case "ObjectKeyword":
		case "Unknown":
		case "Any":
			// A path may go into these values, and the Schema does not say what
			// is there.
			return anyDomain
		default:
			// A path does not go into a scalar, so the field is `null`.
			return nullDomain
	}
}

/**
 * Gives the domain of a field of a Schema, by its path with dots. A path that
 * the Schema does not name gives `null`, as a condition reads such a field.
 *
 * @stability stable
 * @category getters
 * @since 0.5.0
 */
export const domainOf = (schema: Schema.Top, path: string): FieldDomain =>
	// No cache here: a search keeps the cells of each field for itself.
	domainAt(schema.ast, path.split("."), 0, new Set())

const makeDescriptor = (
	kind: string,
	options: Options<ReadonlyArray<string>, Schema.Struct.Fields>,
): Descriptor => {
	// The kind of a value comes from its `_tag`. A field with this name could
	// give a value another kind, so it is a defect.
	if (Object.hasOwn(options.fields, "_tag")) {
		throw new Error(`The resource "${kind}" may not have a field "_tag"`)
	}
	const refs: Record<string, FieldRef<string>> = Object.fromEntries(
		Arr.map(Object.keys(options.fields), (key) => [
			key,
			{ _tag: "Field", field: key },
		]),
	)
	const visits = walkFields(Schema.Struct(options.fields).ast)
	const leaves = Arr.filter(visits, (visit) => visit.leaf)
	// In a union, one path may hold a scalar in one branch and a struct in
	// another. Such a path holds more than one value, so it is open too.
	const structs = HashSet.fromIterable(
		Arr.map(
			Arr.filter(visits, (visit) => !visit.leaf),
			(visit) => visit.path,
		),
	)
	const open = Arr.filter(
		leaves,
		(visit) =>
			shapeOf(visit.type) !== "scalar" || HashSet.has(structs, visit.path),
	)
	return new ResourceDescriptor({
		kind,
		actions: [...options.actions],
		path: options.path === undefined ? undefined : [...options.path(refs)],
		fieldPaths: Arr.dedupe(Arr.map(leaves, (visit) => visit.path)),
		openPaths: Arr.dedupe(Arr.map(open, (visit) => visit.path)),
		schema: Schema.TaggedStruct(kind, options.fields),
	})
}

/**
 * The type of a class made by {@link Class}.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Class<
	Self,
	Kind extends string,
	Actions extends ReadonlyArray<string>,
	Fields extends Schema.Struct.Fields,
> = Schema.Class<Self, Schema.TaggedStruct<Kind, Fields>, {}> &
	Resource<
		Kind,
		Actions[number],
		Schema.Struct.Type<Fields>,
		Self & { readonly _tag: Kind }
	> & {
		readonly kind: Kind
		readonly actions: Actions
	}

/**
 * Makes a resource as a Schema class. Use it in the same way as
 * `Schema.TaggedClass`.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Resource } from "@nmnmcc/ability"
 *
 * class Bot extends Resource.Class<Bot>()("Bot", {
 *   actions: ["read", "update"],
 *   fields: {
 *     id: Schema.String,
 *     ownerUserId: Schema.NullOr(Schema.String),
 *   },
 *   path: (f) => ["user", f.ownerUserId, "bot", f.id],
 * }) {}
 *
 * const bot = new Bot({ id: "b1", ownerUserId: "u1" })
 * ```
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const Class: <Self = never>(
	identifier?: string,
) => <
	const Kind extends string,
	const Actions extends ReadonlyArray<string>,
	const Fields extends Schema.Struct.Fields,
>(
	kind: Kind,
	options: Options<Actions, Fields>,
) => [Self] extends [never]
	? "Missing `Self` type: use Resource.Class<Self>()(...)"
	: Class<Self, Kind, Actions, Fields> = ((identifier?: string) =>
	(
		kind: string,
		options: Options<ReadonlyArray<string>, Schema.Struct.Fields>,
	) => {
		const Base = Schema.TaggedClass<any>(identifier)(kind, options.fields)
		const descriptor = makeDescriptor(kind, options)
		return class extends Base {
			static readonly descriptor = descriptor
			static readonly kind = kind
			static readonly actions = descriptor.actions
		}
	}) as never

/**
 * A resource made by {@link make}. Its values are plain objects.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Struct<
	Kind extends string,
	Actions extends ReadonlyArray<string>,
	Fields extends Schema.Struct.Fields,
> extends Resource<
	Kind,
	Actions[number],
	Schema.Struct.Type<Fields>,
	Schema.Struct.Type<Fields> & { readonly _tag: Kind }
> {
	readonly kind: Kind
	readonly actions: Actions
	readonly schema: Schema.TaggedStruct<Kind, Fields>
	/** Makes a value. It puts the `_tag` field on the value for you. */
	readonly make: (
		input: Schema.Struct.Type<Fields>,
	) => Schema.Struct.Type<Fields> & { readonly _tag: Kind }
}

/**
 * Makes a resource from plain fields. Its values are plain objects with a
 * `_tag` field.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const make: <
	const Kind extends string,
	const Actions extends ReadonlyArray<string>,
	const Fields extends Schema.Struct.Fields,
>(
	kind: Kind,
	options: Options<Actions, Fields>,
) => Struct<Kind, Actions, Fields> = ((
	kind: string,
	options: Options<ReadonlyArray<string>, Schema.Struct.Fields>,
) => {
	const schema = Schema.TaggedStruct(kind, options.fields)
	const descriptor = makeDescriptor(kind, options)
	return {
		descriptor,
		kind,
		actions: descriptor.actions,
		schema,
		make: (input: object) => schema.make(input as never),
	}
}) as never

/**
 * Tests if a value is a resource.
 *
 * @stability stable
 * @category guards
 * @since 0.3.0
 */
export const isResource = (u: unknown): u is Any =>
	hasProperty(u, "descriptor") && u.descriptor instanceof ResourceDescriptor

/**
 * Gets the runtime data of a resource.
 *
 * @stability stable
 * @category getters
 * @since 0.3.0
 */
export const descriptor = (resource: Any): Descriptor => resource.descriptor

/**
 * Gives the kind name of a resource value, from its `_tag` field.
 *
 * @stability stable
 * @category getters
 * @since 0.4.0
 */
export const kindOf = (value: unknown): string | undefined =>
	hasProperty(value, "_tag") && typeof value._tag === "string"
		? value._tag
		: undefined
