import * as Equal from "effect/Equal"
import * as Formatter from "effect/Formatter"
import * as Hash from "effect/Hash"
import * as Inspectable from "effect/Inspectable"
import * as Pipeable from "effect/Pipeable"
import * as Predicate from "effect/Predicate"
import type * as Condition from "../Condition.ts"
import type * as Domain from "../Domain.ts"
import type * as Rule from "../Rule.ts"
import { builder as conditionBuilder } from "./condition.ts"
import { isResource, descriptor } from "./resource.ts"

/** @internal */
export const TypeId = "~@nmnmcc/ability/Rule" as const

/**
 * The plain data of a rule.
 *
 * @internal
 */
export interface RuleData {
	readonly _tag: "Allow" | "Deny"
	readonly actions: ReadonlyArray<string>
	readonly resources: ReadonlyArray<string>
	readonly when?: Condition.Ast
	readonly fields?: ReadonlyArray<string>
	readonly reason?: string
	readonly id?: string
	readonly meta?: unknown
}

/** @internal */
export const toData = (rule: RuleData): RuleData => {
	const data: {
		-readonly [K in keyof RuleData]: RuleData[K]
	} = {
		_tag: rule._tag,
		actions: rule.actions,
		resources: rule.resources,
	}
	if (rule.when !== undefined) data.when = rule.when
	if (rule.fields !== undefined) data.fields = rule.fields
	if (rule.reason !== undefined) data.reason = rule.reason
	if (rule.id !== undefined) data.id = rule.id
	if (rule.meta !== undefined) data.meta = rule.meta
	return data
}

function* ruleIterator<A>(rule: A): Generator<A, A, unknown> {
	yield rule
	return rule
}

const Proto = {
	...Pipeable.Prototype,
	[TypeId]: TypeId,
	[Symbol.iterator](this: Rule.Any) {
		return ruleIterator(this)
	},
	[Equal.symbol](this: RuleData, that: unknown): boolean {
		return isRule(that) && Equal.equals(toData(this), toData(that))
	},
	[Hash.symbol](this: RuleData): number {
		return Hash.structure(toData(this))
	},
	toJSON(this: RuleData) {
		return toData(this)
	},
	toString(this: RuleData) {
		return Formatter.format(toData(this), { space: 2 })
	},
	[Inspectable.NodeInspectSymbol](this: RuleData) {
		return toData(this)
	},
}

/**
 * Makes a rule from plain data. It does not check the data.
 *
 * @internal
 */
export const make = (data: RuleData): Rule.Any => {
	const rule = Object.create(Proto) as {
		-readonly [K in keyof RuleData]: RuleData[K]
	}
	Object.assign(rule, toData(data))
	rule.actions = Object.freeze([...data.actions])
	rule.resources = Object.freeze([...data.resources])
	if (data.fields !== undefined) rule.fields = Object.freeze([...data.fields])
	return Object.freeze(rule) as Rule.Any
}

/** @internal */
export const isRule = (u: unknown): u is Rule.Any =>
	Predicate.hasProperty(u, TypeId)

const toArray = <A>(value: A | ReadonlyArray<A>): ReadonlyArray<A> =>
	Array.isArray(value) ? value : [value as A]

const kindName = (target: unknown): string =>
	isResource(target) ? descriptor(target).kind : (target as string)

const makeFromOptions =
	(tag: "Allow" | "Deny") =>
	(
		action: string | ReadonlyArray<string>,
		resource: unknown,
		options?: {
			readonly when?: (builder: unknown) => Condition.Ast
			readonly fields?: ReadonlyArray<string>
			readonly reason?: string
			readonly id?: string
			readonly meta?: unknown
		},
	): Rule.Any => {
		const data: {
			-readonly [K in keyof RuleData]: RuleData[K]
		} = {
			_tag: tag,
			actions: toArray(action),
			resources: toArray(resource).map(kindName),
		}
		if (options?.when !== undefined)
			data.when = options.when(conditionBuilder())
		if (options?.fields !== undefined) data.fields = options.fields
		if (options?.reason !== undefined) data.reason = options.reason
		if (options?.id !== undefined) data.id = options.id
		if (options?.meta !== undefined) data.meta = options.meta
		return make(data)
	}

const sharedBuilder = Object.freeze({
	allow: makeFromOptions("Allow"),
	deny: makeFromOptions("Deny"),
})

/** @internal */
export const builder = (_domain: Domain.Any): any => sharedBuilder

const patternCache = new Map<string, RegExp>()

const compilePattern = (pattern: string): RegExp => {
	const cached = patternCache.get(pattern)
	if (cached !== undefined) {
		return cached
	}
	let source = ""
	let index = 0
	while (index < pattern.length) {
		const char = pattern[index]!
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				source += ".*"
				index = index + 2
				continue
			}
			source += "[^.]*"
		} else {
			source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
		}
		index = index + 1
	}
	const regex = new RegExp(`^${source}$`)
	patternCache.set(pattern, regex)
	return regex
}

/** @internal */
export const matchesFieldPattern = (pattern: string, field: string): boolean =>
	pattern.includes("*")
		? compilePattern(pattern).test(field)
		: pattern === field

/**
 * Tests the parts of a rule that do not need the resource value: the action,
 * the kind and the field.
 *
 * A rule with fields covers a request with no field only when it is an allow
 * rule. So "may update some fields" is a yes. A deny rule for some fields does
 * not stop a request for the whole value.
 *
 * @internal
 */
export const matchesTarget = (
	rule: RuleData,
	action: string,
	kind: string,
	field: string | undefined,
): boolean => {
	if (!rule.actions.includes("*") && !rule.actions.includes(action)) {
		return false
	}
	if (!rule.resources.includes("*") && !rule.resources.includes(kind)) {
		return false
	}
	if (rule.fields === undefined) {
		return true
	}
	if (field === undefined) {
		return rule._tag === "Allow"
	}
	return rule.fields.some((pattern) => matchesFieldPattern(pattern, field))
}
