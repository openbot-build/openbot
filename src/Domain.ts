/**
 * A domain puts together the principal and all the resources of an
 * application. All other modules get their types from the domain. A rule may
 * only use the actions of its resource. A condition may only use the fields of
 * its resource and of the principal.
 *
 * @example
 * ```ts
 * import { Domain } from "@nmnmcc/ability"
 *
 * const App = Domain.make({ principal: Caller, resources: [Bot, Trigger] })
 * ```
 *
 * @stability stable
 * @since 0.3.0
 */
import * as Arr from "effect/Array"
import * as Data from "effect/Data"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import type * as PrincipalSchema from "./Principal.ts"
import * as Resource from "./Resource.ts"

/**
 * A domain. `P` is the type of the principal, `Resources` is the union of the
 * resources, and `Meta` is the type of the extra data that a rule may keep.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Domain<
	P extends object,
	Resources extends Resource.Any,
	Meta,
> {
	readonly principal: PrincipalSchema.Any
	/** The descriptor of each resource, by its kind name. */
	readonly resources: HashMap.HashMap<string, Resource.Descriptor>
	readonly meta: Schema.Top | undefined
	readonly "~Domain"?: {
		readonly Principal: P
		readonly Resources: Resources
		readonly Meta: Meta
	}
}

/**
 * Any domain.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Any = Domain<any, any, any>

/**
 * The type of the principal of a domain.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Principal<D> = D extends Domain<infer P, any, any> ? P : never

/**
 * The union of the resources of a domain.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Resources<D> = D extends Domain<any, infer R, any> ? R : never

/**
 * The type of the extra data that a rule of the domain may keep.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Meta<D> = D extends Domain<any, any, infer M> ? M : never

/**
 * The kind names of a domain.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Kind<D> = Resource.Kind<Resources<D>>

/**
 * The resource of a domain with the kind `K`.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type ResourceOf<D, K extends string> =
	Resources<D> extends infer R
		? R extends Resource.Resource<K, any, any, any>
			? R
			: never
		: never

/**
 * The actions of the resource with the kind `K`.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type ActionOf<D, K extends string> = Resource.Action<ResourceOf<D, K>>

/**
 * The actions that every kind in `K` has. For one kind, they are its actions.
 * For a union of kinds, an action of only some of them is left out, so a
 * value of the union type can not get an action that its kind does not have.
 *
 * @stability stable
 * @category utility types
 * @since 0.4.0
 */
export type CommonAction<D, K extends string> = (
	K extends unknown ? (action: ActionOf<D, K>) => void : never
) extends (action: infer A) => void
	? A
	: never

/**
 * All the actions of all the resources of a domain.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type AnyAction<D> = Resource.Action<Resources<D>>

/**
 * The data type of the resource with the kind `K`.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type DataOf<D, K extends string> = Resource.Data<ResourceOf<D, K>>

/**
 * The value type of the resource with the kind `K`.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type ValueOf<D, K extends string> = Resource.Value<ResourceOf<D, K>>

/**
 * The union of the value types of all the resources of a domain.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type AnyValue<D> = Resource.Value<Resources<D>>

/**
 * The class of every domain value. {@link isDomain} uses it to know a domain.
 */
class DomainData extends Data.Class<{
	readonly principal: PrincipalSchema.Any
	readonly resources: HashMap.HashMap<string, Resource.Descriptor>
	readonly meta: Schema.Top | undefined
}> {}

/**
 * Makes a domain. Each resource must have its own kind name. Give `meta` when
 * rules must keep extra data, such as the scope of a grant. The `meta` Schema
 * may not need services, because `Policy.schema` gives a Schema that needs
 * none.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const make: <
	P extends PrincipalSchema.Any,
	const Resources extends ReadonlyArray<Resource.Any>,
	M extends Schema.Codec<any, any, never, never> = Schema.Never,
>(options: {
	readonly principal: P
	readonly resources: Resources
	readonly meta?: M
}) => Domain<P["Type"], Resources[number], M["Type"]> = (options) => {
	const descriptors = Arr.map(options.resources, Resource.descriptor)
	const kinds = Arr.map(descriptors, (descriptor) => descriptor.kind)
	// Two resources with one kind name is a mistake in the code, not in the
	// data, so it is a defect.
	const twice = Arr.findFirst(
		kinds,
		(kind, index) => kinds.indexOf(kind) !== index,
	)
	if (Option.isSome(twice)) {
		throw new Error(`Two resources have the kind name "${twice.value}"`)
	}
	if (kinds.includes("*")) {
		throw new Error(`A resource may not have the kind name "*"`)
	}
	const resources = HashMap.fromIterable(
		Arr.map(
			descriptors,
			(descriptor) => [descriptor.kind, descriptor] as const,
		),
	)
	// This checks the field names of the principal. See `Resource.fieldPaths`.
	Resource.fieldPaths(options.principal)
	return new DomainData({
		principal: options.principal,
		resources,
		meta: options.meta,
	})
}

/**
 * Gives the descriptor of the resource with a kind name, or `undefined` when
 * the domain has no such resource.
 *
 * @stability stable
 * @category getters
 * @since 0.4.0
 */
export const descriptorOf = (
	domain: Any,
	kind: string,
): Resource.Descriptor | undefined =>
	Option.getOrUndefined(HashMap.get(domain.resources, kind))

/**
 * Tests if a value is a domain.
 *
 * @stability stable
 * @category guards
 * @since 0.3.0
 */
export const isDomain = (u: unknown): u is Any => u instanceof DomainData
