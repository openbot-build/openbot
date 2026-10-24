import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type * as Resource from "../Resource.ts"

/** @internal */
export const TypeId = "~@nmnmcc/ability/Resource" as const

const fieldRefs = (fields: Schema.Struct.Fields) => {
	const refs: Record<string, Resource.FieldRef<string>> = {}
	for (const key of Object.keys(fields)) {
		refs[key] = Object.freeze({ _tag: "Field", field: key })
	}
	return Object.freeze(refs)
}

const hasFields = (
	schema: unknown,
): schema is { readonly fields: Schema.Struct.Fields } =>
	Predicate.hasProperty(schema, "fields") && Predicate.isObject(schema.fields)

/**
 * Gives the paths of all data fields. A nested struct gives one path for each
 * of its own fields, with a dot between the names.
 */
const collectFieldPaths = (
	fields: Schema.Struct.Fields,
	prefix: string,
	output: Array<string>,
): void => {
	for (const key of Object.keys(fields)) {
		const schema = fields[key]
		const path = prefix === "" ? key : `${prefix}.${key}`
		if (hasFields(schema)) {
			collectFieldPaths(schema.fields, path, output)
		} else {
			output.push(path)
		}
	}
}

const makeDescriptor = (
	kind: string,
	options: Resource.Options<ReadonlyArray<string>, Schema.Struct.Fields>,
	schema: Schema.Top,
): Resource.Descriptor => {
	const fieldPaths: Array<string> = []
	collectFieldPaths(options.fields, "", fieldPaths)
	return Object.freeze({
		kind,
		actions: Object.freeze([...options.actions]),
		path:
			options.path === undefined
				? undefined
				: Object.freeze([...options.path(fieldRefs(options.fields))]),
		fieldPaths: Object.freeze(fieldPaths),
		schema,
	})
}

/** @internal */
export const Class =
	(identifier?: string) =>
	(
		kind: string,
		options: Resource.Options<ReadonlyArray<string>, Schema.Struct.Fields>,
	) => {
		const Base = Schema.TaggedClass<any>(identifier)(kind, options.fields)
		const descriptor = makeDescriptor(kind, options, Base)
		return class extends Base {
			static readonly [TypeId] = descriptor
			static readonly kind = kind
			static readonly actions = descriptor.actions
		}
	}

/** @internal */
export const make = (
	kind: string,
	options: Resource.Options<ReadonlyArray<string>, Schema.Struct.Fields>,
) => {
	const schema = Schema.TaggedStruct(kind, options.fields)
	const descriptor = makeDescriptor(kind, options, schema)
	return Object.freeze({
		[TypeId]: descriptor,
		kind,
		actions: descriptor.actions,
		schema,
		make: (input: object) => schema.make(input as never),
	})
}

/** @internal */
export const isResource = (u: unknown): u is Resource.Any =>
	Predicate.hasProperty(u, TypeId)

/** @internal */
export const descriptor = (resource: Resource.Any): Resource.Descriptor =>
	resource[TypeId]
