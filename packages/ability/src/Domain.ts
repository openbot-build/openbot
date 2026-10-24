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
import type * as Schema from "effect/Schema"
import * as internal from "./internal/domain.ts"
import type * as PrincipalSchema from "./Principal.ts"
import type * as Resource from "./Resource.ts"

/**
 * @stability stable
 * @category type IDs
 * @since 0.3.0
 */
export const TypeId: "~@nmnmcc/ability/Domain" = internal.TypeId

/**
 * @stability stable
 * @category type IDs
 * @since 0.3.0
 */
export type TypeId = typeof TypeId

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
	readonly [TypeId]: TypeId
	readonly principal: PrincipalSchema.Any
	readonly resources: ReadonlyMap<string, Resource.Descriptor>
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
 * Makes a domain. Each resource must have its own kind name. Give `meta` when
 * rules must keep extra data, such as the scope of a grant.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const make: <
	P extends PrincipalSchema.Any,
	const Resources extends ReadonlyArray<Resource.Any>,
	M extends Schema.Top = Schema.Never,
>(options: {
	readonly principal: P
	readonly resources: Resources
	readonly meta?: M
}) => Domain<P["Type"], Resources[number], M["Type"]> = internal.make

/**
 * Tests if a value is a domain.
 *
 * @stability stable
 * @category guards
 * @since 0.3.0
 */
export const isDomain: (u: unknown) => u is Any = internal.isDomain
