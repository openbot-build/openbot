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
import * as Schema from "effect/Schema"
import * as internal from "./internal/resource.ts"

/**
 * @stability stable
 * @category type IDs
 * @since 0.3.0
 */
export const TypeId: "~@nmnmcc/ability/Resource" = internal.TypeId

/**
 * @stability stable
 * @category type IDs
 * @since 0.3.0
 */
export type TypeId = typeof TypeId

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
	/** The Schema of the values, with the `_tag` field. */
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
	readonly [TypeId]: Descriptor
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
	: Class<Self, Kind, Actions, Fields> = internal.Class as never

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
) => Struct<Kind, Actions, Fields> = internal.make as never

/**
 * Tests if a value is a resource.
 *
 * @stability stable
 * @category guards
 * @since 0.3.0
 */
export const isResource: (u: unknown) => u is Any = internal.isResource

/**
 * Gets the runtime data of a resource.
 *
 * @stability stable
 * @category getters
 * @since 0.3.0
 */
export const descriptor: (resource: Any) => Descriptor = internal.descriptor
