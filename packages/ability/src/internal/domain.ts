import * as Predicate from "effect/Predicate"
import type * as Schema from "effect/Schema"
import type * as Domain from "../Domain.ts"
import type * as Principal from "../Principal.ts"
import type * as Resource from "../Resource.ts"
import { descriptor } from "./resource.ts"

/** @internal */
export const TypeId = "~@nmnmcc/ability/Domain" as const

/** @internal */
export const make = (options: {
	readonly principal: Principal.Any
	readonly resources: ReadonlyArray<Resource.Any>
	readonly meta?: Schema.Top
}): any => {
	const resources = new Map<string, Resource.Descriptor>()
	for (const resource of options.resources) {
		const value = descriptor(resource)
		if (resources.has(value.kind)) {
			// Two resources with one kind name is a mistake in the code, not in the
			// data, so it is a defect.
			throw new Error(`Two resources have the kind name "${value.kind}"`)
		}
		if (value.kind === "*") {
			throw new Error(`A resource may not have the kind name "*"`)
		}
		resources.set(value.kind, value)
	}
	return Object.freeze({
		[TypeId]: TypeId,
		principal: options.principal,
		resources,
		meta: options.meta,
	})
}

/** @internal */
export const isDomain = (u: unknown): u is Domain.Any =>
	Predicate.hasProperty(u, TypeId)

/** @internal */
export const getDescriptor = (
	domain: Domain.Any,
	kind: string,
): Resource.Descriptor | undefined => domain.resources.get(kind)

/**
 * Gives the kind name of a resource value, from its `_tag` field.
 *
 * @internal
 */
export const kindOf = (value: unknown): string | undefined =>
	Predicate.hasProperty(value, "_tag") && typeof value._tag === "string"
		? value._tag
		: undefined
