// A policy keeps the error type and the service type of its predicates only in
// the public types. Inside this file they are erased to `unknown`, so the
// language service check for `unknown` in an Effect is off here.
// @effect-diagnostics anyUnknownInErrorContext:off
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Formatter from "effect/Formatter"
import { dual } from "effect/Function"
import * as Hash from "effect/Hash"
import * as Inspectable from "effect/Inspectable"
import * as Pipeable from "effect/Pipeable"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import type * as Condition from "../Condition.ts"
import * as Decision from "../Decision.ts"
import type * as Domain from "../Domain.ts"
import type * as Policy from "../Policy.ts"
import type * as Rule from "../Rule.ts"
import * as condition from "./condition.ts"
import { getDescriptor, kindOf } from "./domain.ts"
import * as rule from "./rule.ts"

/** @internal */
export const TypeId = "~@nmnmcc/ability/Policy" as const

type Node = Policy.Node
type Ast = Condition.Ast

interface PolicyData {
	readonly domain: Domain.Any
	readonly node: Node
}

/** @internal */
export const encodeNode = (node: Node): Policy.EncodedNode => {
	switch (node._tag) {
		case "Rules":
			return {
				_tag: "Rules",
				algorithm: node.algorithm,
				rules: node.rules.map(
					(value) => rule.toData(value) as Policy.EncodedRule,
				),
			}
		case "All":
		case "Any":
		case "FirstOf":
			return { _tag: node._tag, policies: node.policies.map(encodeNode) }
		case "Ceiling":
			return {
				_tag: "Ceiling",
				cap: encodeNode(node.cap),
				policy: encodeNode(node.policy),
			}
	}
}

const Proto = {
	...Pipeable.Prototype,
	[TypeId]: TypeId,
	[Equal.symbol](this: PolicyData, that: unknown): boolean {
		return (
			isPolicy(that) &&
			this.domain === (that as unknown as PolicyData).domain &&
			Equal.equals(this.node, (that as unknown as PolicyData).node)
		)
	},
	[Hash.symbol](this: PolicyData): number {
		return Hash.hash(this.node)
	},
	toJSON(this: PolicyData) {
		return encodeNode(this.node)
	},
	toString(this: PolicyData) {
		return Formatter.format(encodeNode(this.node), { space: 2 })
	},
	[Inspectable.NodeInspectSymbol](this: PolicyData) {
		return encodeNode(this.node)
	},
}

/** @internal */
export const isPolicy = (u: unknown): u is Policy.Policy<Domain.Any> =>
	Predicate.hasProperty(u, TypeId)

/** @internal */
export const fromNode = (domain: Domain.Any, node: Node): any => {
	const self = Object.create(Proto) as { domain: Domain.Any; node: Node }
	self.domain = domain
	self.node = node
	return Object.freeze(self)
}

const nodeOf = (policy: unknown): Node => (policy as PolicyData).node
const domainOf = (policy: unknown): Domain.Any => (policy as PolicyData).domain

/** @internal */
export const rules = (
	domain: Domain.Any,
	values: Iterable<Rule.Any>,
	options?: { readonly algorithm?: Policy.Algorithm },
): any =>
	fromNode(
		domain,
		Object.freeze({
			_tag: "Rules",
			algorithm: options?.algorithm ?? "denyOverrides",
			rules: Object.freeze(Array.from(values)),
		}),
	)

/** @internal */
export const empty = (domain: Domain.Any): any => rules(domain, [])

/** @internal */
export const define =
	(domain: Domain.Any, options?: { readonly algorithm?: Policy.Algorithm }) =>
	(body: (builder: unknown) => Generator<Rule.Any, unknown, unknown>): any => {
		const collected: Array<Rule.Any> = []
		const iterator = body(rule.builder(domain))
		let state = iterator.next()
		while (state.done !== true) {
			collected.push(state.value)
			state = iterator.next(state.value)
		}
		return rules(domain, collected, options)
	}

const combine =
	(tag: "All" | "Any" | "FirstOf") =>
	(policies: ReadonlyArray<unknown>): any => {
		const domain = domainOf(policies[0])
		for (const policy of policies) {
			if (domainOf(policy) !== domain) {
				throw new Error("Policies from two domains can not be put together")
			}
		}
		return fromNode(
			domain,
			Object.freeze({
				_tag: tag,
				policies: Object.freeze(policies.map(nodeOf)),
			}),
		)
	}

/** @internal */
export const all = combine("All")
/** @internal */
export const any = combine("Any")
/** @internal */
export const firstOf = combine("FirstOf")

/** @internal */
export const ceiling = dual(2, (policy: unknown, cap: unknown): any => {
	if (domainOf(policy) !== domainOf(cap)) {
		throw new Error("Policies from two domains can not be put together")
	}
	return fromNode(
		domainOf(policy),
		Object.freeze({
			_tag: "Ceiling",
			cap: nodeOf(cap),
			policy: nodeOf(policy),
		}),
	)
})

// Decisions

interface Context {
	readonly principal: object
	readonly action: string
	readonly kind: string
	readonly value: object
	readonly field: string | undefined
	readonly input: Condition.Input
	readonly trace: Array<Policy.Step> | undefined
}

const ruleApplies = (
	value: Rule.Any,
	context: Context,
	path: ReadonlyArray<number>,
): Effect.Effect<boolean, unknown, unknown> => {
	if (!rule.matchesTarget(value, context.action, context.kind, context.field)) {
		return Effect.succeed(false)
	}
	const test =
		value.when === undefined
			? Effect.succeed(true)
			: condition.evaluateOf(value.when, context.input)
	return context.trace === undefined
		? test
		: Effect.tap(test, (applies) =>
				Effect.sync(() => {
					context.trace!.push({ path, rule: value, applies })
				}),
			)
}

const fromRule = (value: Rule.Any): Decision.Decision =>
	value._tag === "Allow"
		? Decision.Allow({ rule: value })
		: value.reason === undefined
			? Decision.Deny({ rule: value })
			: Decision.Deny({ rule: value, reason: value.reason })

const firstApplying = Effect.fnUntraced(function* (
	candidates: ReadonlyArray<readonly [Rule.Any, number]>,
	context: Context,
	path: ReadonlyArray<number>,
): Effect.fn.Return<Rule.Any | undefined, unknown, unknown> {
	for (const [value, index] of candidates) {
		if (yield* ruleApplies(value, context, [...path, index])) {
			return value
		}
	}
	return undefined
})

const decideRules = Effect.fnUntraced(function* (
	node: Policy.RulesNode,
	context: Context,
	path: ReadonlyArray<number>,
): Effect.fn.Return<Decision.Decision, unknown, unknown> {
	const indexed = node.rules.map((value, index) => [value, index] as const)
	const denies = indexed.filter(([value]) => value._tag === "Deny")
	const allows = indexed.filter(([value]) => value._tag === "Allow")
	let found: Rule.Any | undefined
	switch (node.algorithm) {
		case "denyOverrides":
			found =
				(yield* firstApplying(denies, context, path)) ??
				(yield* firstApplying(allows, context, path))
			break
		case "permitOverrides":
			found =
				(yield* firstApplying(allows, context, path)) ??
				(yield* firstApplying(denies, context, path))
			break
		case "firstApplicable":
			found = yield* firstApplying(indexed, context, path)
			break
		case "lastApplicable":
			found = yield* firstApplying(indexed.slice().reverse(), context, path)
			break
	}
	return found === undefined ? Decision.NotApplicable : fromRule(found)
})

const decideNode = (
	node: Node,
	context: Context,
	path: ReadonlyArray<number>,
): Effect.Effect<Decision.Decision, unknown, unknown> => {
	switch (node._tag) {
		case "Rules":
			return decideRules(node, context, path)
		case "All":
			return Effect.gen(function* () {
				let firstAllow: Decision.Decision | undefined
				let allAllow = node.policies.length > 0
				for (const [index, child] of node.policies.entries()) {
					const result = yield* decideNode(child, context, [...path, index])
					if (result._tag === "Deny") {
						return result
					}
					if (result._tag === "Allow") {
						firstAllow ??= result
					} else {
						allAllow = false
					}
				}
				return allAllow && firstAllow !== undefined
					? firstAllow
					: Decision.NotApplicable
			})
		case "Any":
			return Effect.gen(function* () {
				let firstDeny: Decision.Decision | undefined
				for (const [index, child] of node.policies.entries()) {
					const result = yield* decideNode(child, context, [...path, index])
					if (result._tag === "Allow") {
						return result
					}
					if (result._tag === "Deny") {
						firstDeny ??= result
					}
				}
				return firstDeny ?? Decision.NotApplicable
			})
		case "FirstOf":
			return Effect.gen(function* () {
				for (const [index, child] of node.policies.entries()) {
					const result = yield* decideNode(child, context, [...path, index])
					if (result._tag !== "NotApplicable") {
						return result
					}
				}
				return Decision.NotApplicable
			})
		case "Ceiling":
			return Effect.gen(function* () {
				const capped = yield* decideNode(node.cap, context, [...path, 0])
				if (capped._tag === "Deny") {
					return capped
				}
				return yield* decideNode(node.policy, context, [...path, 1])
			})
	}
}

const makeContext = (
	domain: Domain.Any,
	request: Policy.AnyRequest,
	trace: Array<Policy.Step> | undefined,
): Context | undefined => {
	const kind = kindOf(request.resource)
	const descriptor =
		kind === undefined ? undefined : getDescriptor(domain, kind)
	if (kind === undefined || descriptor === undefined) {
		return undefined
	}
	return {
		principal: request.principal,
		action: request.action,
		kind,
		value: request.resource,
		field: request.field,
		input: {
			value: request.resource,
			principal: request.principal,
			path: descriptor.path,
		},
		trace,
	}
}

/** @internal */
export const decideOf = (
	policy: unknown,
	request: Policy.AnyRequest,
): Effect.Effect<Decision.Decision, unknown, unknown> => {
	const context = makeContext(domainOf(policy), request, undefined)
	return context === undefined
		? Effect.succeed(Decision.NotApplicable)
		: decideNode(nodeOf(policy), context, [])
}

/** @internal */
export const decide = dual(2, decideOf)

/** @internal */
export const decideSync = dual(
	2,
	(policy: unknown, request: Policy.AnyRequest): Decision.Decision =>
		Effect.runSync(
			// The public type of `decideSync` takes only policies with no
			// predicates, so this Effect has no error and needs no services.
			// @effect-diagnostics-next-line unsafeEffectTypeAssertion:off
			decideOf(policy, request) as Effect.Effect<Decision.Decision>,
		),
)

/** @internal */
export const explainOf = (
	policy: unknown,
	request: Policy.AnyRequest,
): Effect.Effect<Policy.Explanation, unknown, unknown> => {
	const trace: Array<Policy.Step> = []
	const context = makeContext(domainOf(policy), request, trace)
	if (context === undefined) {
		return Effect.succeed({ decision: Decision.NotApplicable, steps: [] })
	}
	return Effect.map(decideNode(nodeOf(policy), context, []), (decision) => ({
		decision,
		steps: Object.freeze(trace),
	}))
}

/** @internal */
export const explain = dual(2, explainOf)

/** @internal */
export const permittedFieldsOf = Effect.fnUntraced(function* (
	policy: unknown,
	request: Omit<Policy.AnyRequest, "field">,
): Effect.fn.Return<ReadonlyArray<string>, unknown, unknown> {
	const domain = domainOf(policy)
	const kind = kindOf(request.resource)
	const descriptor =
		kind === undefined ? undefined : getDescriptor(domain, kind)
	if (descriptor === undefined) {
		return []
	}
	const output: Array<string> = []
	for (const field of descriptor.fieldPaths) {
		const result: Decision.Decision = yield* decideOf(policy, {
			...request,
			field,
		})
		if (result._tag === "Allow") {
			output.push(field)
		}
	}
	return Object.freeze(output)
})

/** @internal */
export const permittedFields = dual(2, permittedFieldsOf)

// Residual conditions

interface Pair {
	readonly allow: Ast
	readonly deny: Ast
}

const { always, never, simplify } = condition
const and = (...values: ReadonlyArray<Ast>): Ast =>
	simplify(condition.and(...values))
const or = (...values: ReadonlyArray<Ast>): Ast =>
	simplify(condition.or(...values))
const not = (value: Ast): Ast => simplify(condition.not(value))

interface ResidualContext {
	readonly principal: object
	readonly action: string
	readonly kind: string
	readonly field: string | undefined
	readonly input: {
		readonly principal: object
		readonly path: Condition.Input["path"]
	}
}

const ruleCondition = (value: Rule.Any, context: ResidualContext): Ast =>
	!rule.matchesTarget(value, context.action, context.kind, context.field)
		? never
		: value.when === undefined
			? always
			: condition.partialOf(value.when, context.input)

/**
 * Gives the conditions for "the first rule that applies is an allow rule" and
 * "the first rule that applies is a deny rule".
 */
const firstApplicableResidual = (
	values: ReadonlyArray<Rule.Any>,
	context: ResidualContext,
): Pair => {
	let allow: Ast = never
	let deny: Ast = never
	for (const value of values.slice().reverse()) {
		const applies = ruleCondition(value, context)
		if (value._tag === "Allow") {
			allow = or(applies, allow)
			deny = and(not(applies), deny)
		} else {
			deny = or(applies, deny)
			allow = and(not(applies), allow)
		}
	}
	return { allow, deny }
}

const residualNode = (node: Node, context: ResidualContext): Pair => {
	switch (node._tag) {
		case "Rules": {
			switch (node.algorithm) {
				case "denyOverrides": {
					const deny = or(
						...node.rules
							.filter((value) => value._tag === "Deny")
							.map((value) => ruleCondition(value, context)),
					)
					const allow = and(
						or(
							...node.rules
								.filter((value) => value._tag === "Allow")
								.map((value) => ruleCondition(value, context)),
						),
						not(deny),
					)
					return { allow, deny }
				}
				case "permitOverrides": {
					const allow = or(
						...node.rules
							.filter((value) => value._tag === "Allow")
							.map((value) => ruleCondition(value, context)),
					)
					const deny = and(
						or(
							...node.rules
								.filter((value) => value._tag === "Deny")
								.map((value) => ruleCondition(value, context)),
						),
						not(allow),
					)
					return { allow, deny }
				}
				case "firstApplicable":
					return firstApplicableResidual(node.rules, context)
				case "lastApplicable":
					return firstApplicableResidual(node.rules.slice().reverse(), context)
			}
		}
		// falls through: every algorithm returns above
		case "All": {
			if (node.policies.length === 0) {
				return { allow: never, deny: never }
			}
			const pairs = node.policies.map((child) => residualNode(child, context))
			const deny = or(...pairs.map((pair) => pair.deny))
			const allow = and(...pairs.map((pair) => pair.allow), not(deny))
			return { allow, deny }
		}
		case "Any": {
			const pairs = node.policies.map((child) => residualNode(child, context))
			const allow = or(...pairs.map((pair) => pair.allow))
			const deny = and(or(...pairs.map((pair) => pair.deny)), not(allow))
			return { allow, deny }
		}
		case "FirstOf": {
			let allow: Ast = never
			let deny: Ast = never
			for (const child of node.policies.slice().reverse()) {
				const pair = residualNode(child, context)
				const nextAllow = or(pair.allow, and(not(pair.deny), allow))
				deny = or(pair.deny, and(not(pair.allow), deny))
				allow = nextAllow
			}
			return { allow, deny }
		}
		case "Ceiling": {
			const cap = residualNode(node.cap, context)
			const inner = residualNode(node.policy, context)
			return {
				allow: and(not(cap.deny), inner.allow),
				deny: or(cap.deny, inner.deny),
			}
		}
	}
}

/** @internal */
export const residualPair = (
	policy: unknown,
	request: Policy.KindRequest<Domain.Any>,
): Pair => {
	const domain = domainOf(policy)
	const descriptor = getDescriptor(domain, request.kind)
	if (descriptor === undefined) {
		return { allow: never, deny: never }
	}
	return residualNode(nodeOf(policy), {
		principal: request.principal,
		action: request.action,
		kind: request.kind,
		field: request.field,
		input: { principal: request.principal, path: descriptor.path },
	})
}

/** @internal */
export const residualOf = (
	policy: unknown,
	request: Policy.KindRequest<Domain.Any>,
): Ast => residualPair(policy, request).allow

/** @internal */
export const residual = dual(2, residualOf)

// Schema

const Algorithm = Schema.Literals([
	"denyOverrides",
	"permitOverrides",
	"firstApplicable",
	"lastApplicable",
])

const encodedRuleSchema = (meta: Schema.Top | undefined) =>
	Schema.Struct({
		_tag: Schema.Literals(["Allow", "Deny"]),
		actions: Schema.Array(Schema.String),
		resources: Schema.Array(Schema.String),
		when: Schema.optionalKey(condition.schema),
		fields: Schema.String.pipe(Schema.Array, Schema.optionalKey),
		reason: Schema.optionalKey(Schema.String),
		id: Schema.optionalKey(Schema.String),
		meta: Schema.optionalKey(
			(meta ?? Schema.Never) as Schema.Codec<unknown, unknown>,
		),
	})

const encodedNodeSchema = (
	meta: Schema.Top | undefined,
): Schema.Codec<Policy.EncodedNode> => {
	const self: Schema.Codec<Policy.EncodedNode> = Schema.Union([
		Schema.TaggedStruct("Rules", {
			algorithm: Algorithm,
			rules: Schema.Array(encodedRuleSchema(meta)),
		}),
		Schema.TaggedStruct("All", {
			policies: Schema.Array(Schema.suspend(() => self)),
		}),
		Schema.TaggedStruct("Any", {
			policies: Schema.Array(Schema.suspend(() => self)),
		}),
		Schema.TaggedStruct("FirstOf", {
			policies: Schema.Array(Schema.suspend(() => self)),
		}),
		Schema.TaggedStruct("Ceiling", {
			cap: Schema.suspend(() => self),
			policy: Schema.suspend(() => self),
		}),
	]) as never
	return self
}

const principalFieldPaths = (domain: Domain.Any): ReadonlySet<string> => {
	const output = new Set<string>()
	const visit = (schema: unknown, prefix: string): void => {
		if (
			!Predicate.hasProperty(schema, "fields") ||
			!Predicate.isObject(schema.fields)
		) {
			return
		}
		const fields = schema.fields as Record<string, unknown>
		for (const key of Object.keys(fields)) {
			const path = prefix === "" ? key : `${prefix}.${key}`
			output.add(path)
			visit(fields[key], path)
		}
	}
	visit(domain.principal, "")
	return output
}

const principalRefs = (ast: Condition.Encoded | Ast): ReadonlyArray<string> => {
	const output: Array<string> = []
	const visitOperand = (operand: Condition.Operand) => {
		if (operand._tag === "Principal") output.push(operand.path)
	}
	const visit = (node: Condition.Encoded | Ast): void => {
		switch (node._tag) {
			case "Compare":
				visitOperand(node.value)
				return
			case "In":
				node.values.forEach(visitOperand)
				return
			case "Under":
				node.prefix.forEach(visitOperand)
				return
			case "And":
			case "Or":
				;(node.conditions as ReadonlyArray<Ast>).forEach(visit)
				return
			case "Not":
				visit(node.condition)
				return
			default:
				return
		}
	}
	visit(ast)
	return output
}

/**
 * Checks the names in an encoded policy against the domain. It gives one
 * message for each problem.
 */
const validate = (
	domain: Domain.Any,
	root: Policy.EncodedNode,
): ReadonlyArray<Schema.FilterIssue> => {
	const issues: Array<Schema.FilterIssue> = []
	const principalPaths = principalFieldPaths(domain)
	const visit = (
		node: Policy.EncodedNode,
		path: ReadonlyArray<PropertyKey>,
	) => {
		switch (node._tag) {
			case "Rules":
				node.rules.forEach((value, index) => {
					const at = [...path, "rules", index]
					const kinds = value.resources.includes("*")
						? undefined
						: value.resources
					const descriptors = []
					for (const kind of value.resources) {
						if (kind === "*") continue
						const descriptor = getDescriptor(domain, kind)
						if (descriptor === undefined) {
							issues.push({
								path: [...at, "resources"],
								issue: `There is no resource with the kind "${kind}"`,
							})
						} else {
							descriptors.push(descriptor)
						}
					}
					const known =
						kinds === undefined
							? Array.from(domain.resources.values())
							: descriptors
					for (const action of value.actions) {
						if (action === "*") continue
						if (
							!known.some((descriptor) => descriptor.actions.includes(action))
						) {
							issues.push({
								path: [...at, "actions"],
								issue: `The action "${action}" is not an action of these resources`,
							})
						}
					}
					const usedFields = [
						...(value.fields ?? []).filter((field) => !field.includes("*")),
						...(value.when === undefined
							? []
							: condition.fields(value.when as Ast)),
					]
					for (const field of usedFields) {
						const everywhere =
							kinds !== undefined &&
							descriptors.length > 0 &&
							descriptors.every((descriptor) =>
								descriptor.fieldPaths.includes(field),
							)
						if (!everywhere) {
							issues.push({
								path: at,
								issue: `The field "${field}" is not a field of every resource of the rule`,
							})
						}
					}
					if (value.when !== undefined) {
						for (const ref of principalRefs(value.when)) {
							if (!principalPaths.has(ref)) {
								issues.push({
									path: [...at, "when"],
									issue: `The principal has no field "${ref}"`,
								})
							}
						}
					}
				})
				return
			case "All":
			case "Any":
			case "FirstOf":
				node.policies.forEach((child, index) =>
					visit(child, [...path, "policies", index]),
				)
				return
			case "Ceiling":
				visit(node.cap, [...path, "cap"])
				visit(node.policy, [...path, "policy"])
				return
		}
	}
	visit(root, [])
	return issues
}

const decodeNode = (node: Policy.EncodedNode): Node => {
	switch (node._tag) {
		case "Rules":
			return Object.freeze({
				_tag: "Rules",
				algorithm: node.algorithm,
				rules: Object.freeze(
					node.rules.map((value) => rule.make(value as rule.RuleData)),
				),
			})
		case "All":
		case "Any":
		case "FirstOf":
			return Object.freeze({
				_tag: node._tag,
				policies: Object.freeze(node.policies.map(decodeNode)),
			})
		case "Ceiling":
			return Object.freeze({
				_tag: "Ceiling",
				cap: decodeNode(node.cap),
				policy: decodeNode(node.policy),
			})
	}
}

/** @internal */
export const schema = (domain: Domain.Any): any =>
	encodedNodeSchema(domain.meta).pipe(
		Schema.check(Schema.makeFilter((node) => validate(domain, node))),
		Schema.decodeTo(
			Schema.declare(
				(u): u is Policy.Policy<Domain.Any> =>
					isPolicy(u) && domainOf(u) === domain,
			),
			SchemaTransformation.transform({
				decode: (node: Policy.EncodedNode) =>
					fromNode(domain, decodeNode(node)),
				encode: (policy: Policy.Policy<Domain.Any>) => encodeNode(policy.node),
			}),
		),
	)
