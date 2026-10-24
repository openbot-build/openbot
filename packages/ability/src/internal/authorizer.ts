// The service erases the error type and the service type of predicates,
// principals and deciders to `unknown`. The public types in
// `src/Authorizer.ts` keep them, so the language service check for `unknown`
// in an Effect is off here.
// @effect-diagnostics anyUnknownInErrorContext:off
import * as Cache from "effect/Cache"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Hash from "effect/Hash"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Authorizer from "../Authorizer.ts"
// The error classes are in the public module, so that the types of other
// packages can name them. This file uses them only inside functions, so the
// import cycle with "../Authorizer.ts" is safe.
import { Forbidden, PolicyUnavailable } from "../Authorizer.ts"
import type * as Condition from "../Condition.ts"
import * as Decision from "../Decision.ts"
import type * as Domain from "../Domain.ts"
import type * as Policy from "../Policy.ts"
import { kindOf } from "./domain.ts"
import * as policy from "./policy.ts"

type AnyTarget = {
	readonly action: string
	readonly resource?: object
	readonly kind?: string
	readonly field?: string
}

/** @internal */
export const Service =
	() =>
	(id: string, domain: Domain.Any): Authorizer.AnyServiceClass => {
		const Base = Context.Service<any, any>()(id)
		return class extends Base {
			static readonly domain = domain
			static readonly decide = (target: AnyTarget) =>
				this.use((service: any) => service.decide(target))
			static readonly check = (target: AnyTarget) =>
				this.use((service: any) => service.check(target))
			static readonly guard = (target: AnyTarget, options: unknown) =>
				this.use((service: any) => service.guard(target, options))
			static readonly filter = (target: AnyTarget) =>
				this.use((service: any) => service.filter(target))
			static readonly permittedFields = (target: AnyTarget) =>
				this.use((service: any) => service.permittedFields(target))
		} as never
	}

/**
 * A cache key for a principal. Two principals with the same encoded value are
 * the same key.
 */
class PrincipalKey implements Equal.Equal {
	readonly principal: object
	readonly json: string
	constructor(principal: object, json: string) {
		this.principal = principal
		this.json = json
	}
	[Equal.symbol](that: unknown): boolean {
		return that instanceof PrincipalKey && that.json === this.json
	}
	[Hash.symbol](): number {
		return Hash.string(this.json)
	}
}

const forbidden = (
	target: AnyTarget,
	kind: string,
	reason: string | undefined,
): Forbidden =>
	Forbidden.make({
		action: target.action,
		kind,
		...(target.field === undefined ? {} : { field: target.field }),
		...(reason === undefined ? {} : { reason }),
	})

/** @internal */
export const layer = (
	service: Authorizer.AnyServiceClass,
	options: {
		readonly principal: Effect.Effect<object, unknown, unknown>
		readonly policy: (
			principal: object,
		) => Effect.Effect<Policy.Any, unknown, unknown>
		readonly decider?: (
			request: object,
		) => Effect.Effect<Decision.Decision, unknown, unknown>
		readonly cache?:
			{ readonly capacity?: number; readonly timeToLive?: any } | false
	},
) => {
	const domain: Domain.Any = service.domain
	const encode = Schema.encodeUnknownSync(
		domain.principal as unknown as Schema.Codec<unknown, unknown>,
	)
	const keyOf = (principal: object) =>
		new PrincipalKey(principal, JSON.stringify(encode(principal)))
	return Layer.effect(
		service,
		Effect.gen(function* () {
			// The services of the policy loader and of the predicates come from the
			// layer, so a check does not need them.
			const services = yield* Effect.context<never>()

			const load = (principal: object) =>
				options.policy(principal).pipe(
					Effect.provideContext(services),
					Effect.mapError((cause) => PolicyUnavailable.make({ cause })),
				)

			const cache =
				options.cache === false
					? undefined
					: yield* Cache.make({
							capacity: options.cache?.capacity ?? 1000,
							timeToLive: options.cache?.timeToLive ?? "30 seconds",
							lookup: (key: PrincipalKey) => load(key.principal),
						})

			const policyFor = (principal: object) => {
				if (cache === undefined) {
					return load(principal)
				}
				const key = keyOf(principal)
				// A failed lookup is kept in the cache. Remove it, so the next check
				// tries again.
				return Cache.get(cache, key).pipe(
					Effect.tapError(() => Cache.invalidate(cache, key)),
				)
			}

			const withServices = <A, E>(
				effect: Effect.Effect<A, E, unknown>,
			): Effect.Effect<A, E, unknown> => Effect.provideContext(effect, services)

			const current = Effect.gen(function* () {
				const principal = yield* options.principal
				const value = yield* policyFor(principal)
				return { principal, policy: value }
			})

			const decide = Effect.fnUntraced(function* (target: AnyTarget) {
				const { principal, policy: value } = yield* current
				const decision: Decision.Decision = yield* withServices(
					policy.decideOf(value, { ...target, principal } as never),
				)
				return decision
			})

			const kindDecision = (
				value: Policy.Any,
				principal: object,
				target: AnyTarget,
			): Decision.Decision => {
				const pair = policy.residualPair(value, {
					...target,
					principal,
				} as never)
				if (pair.allow._tag === "True") {
					return Decision.Allow({})
				}
				if (pair.deny._tag === "True") {
					return Decision.Deny({})
				}
				return Decision.NotApplicable
			}

			const check = Effect.fnUntraced(function* (target: AnyTarget) {
				const { principal, policy: value } = yield* current
				const kind =
					target.resource === undefined
						? (target.kind ?? "")
						: (kindOf(target.resource) ?? "")
				let decision: Decision.Decision =
					target.resource === undefined
						? kindDecision(value, principal, target)
						: yield* withServices(
								policy.decideOf(value, { ...target, principal } as never),
							)
				if (
					decision._tag === "NotApplicable" &&
					options.decider !== undefined
				) {
					decision = yield* options.decider({ ...target, principal })
				}
				if (decision._tag !== "Allow") {
					return yield* forbidden(target, kind, Decision.reason(decision))
				}
			})

			const guard = Effect.fnUntraced(function* (
				target: AnyTarget,
				guardOptions: {
					readonly read?: string
					readonly hide: () => unknown
				},
			) {
				const read = guardOptions.read ?? "read"
				const { field: _field, ...rest } = target
				const visible: Decision.Decision = yield* decide({
					...rest,
					action: read,
				})
				if (visible._tag !== "Allow") {
					return yield* Effect.fail(guardOptions.hide())
				}
				if (target.action !== read || target.field !== undefined) {
					yield* check(target)
				}
			})

			const filter = (
				target: AnyTarget,
			): Effect.Effect<Condition.Ast, unknown, unknown> =>
				Effect.map(current, ({ principal, policy: value }) =>
					policy.residualOf(value, { ...target, principal } as never),
				)

			const permittedFields = Effect.fnUntraced(function* (target: AnyTarget) {
				const { principal, policy: value } = yield* current
				return yield* withServices(
					policy.permittedFieldsOf(value, { ...target, principal } as never),
				)
			})

			const invalidate = (principal?: object) =>
				cache === undefined
					? Effect.void
					: principal === undefined
						? Cache.invalidateAll(cache)
						: Cache.invalidate(cache, keyOf(principal))

			return {
				domain,
				principal: options.principal,
				policy: Effect.map(current, ({ policy: value }) => value),
				decide,
				check,
				guard,
				filter,
				permittedFields,
				invalidate,
			} as never
		}),
	)
}
