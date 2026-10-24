// A `load` function of a requirement is kept in an annotation, so its error
// type and its service type are erased to `unknown`. The language service
// check for `unknown` in an Effect is off here.
// @effect-diagnostics anyUnknownInErrorContext:off
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { HttpRouter } from "effect/http"
import type * as Authorizer from "../Authorizer.ts"
import type * as HttpApi from "../HttpApi.ts"
import { GroupRequired, Required } from "../HttpApi.ts"

/** @internal */
export const requires = (
	_authorizer: unknown,
	action: string,
	kind: string,
	load?: HttpApi.Requirement["load"],
): HttpApi.Requirement =>
	Object.freeze(load === undefined ? { action, kind } : { action, kind, load })

/** @internal */
export const layer = (
	middleware: Context.ServiceClass<any, string, any>,
	authorizer: Authorizer.AnyServiceClass,
) =>
	Layer.effect(
		middleware,
		Effect.gen(function* () {
			const service = yield* authorizer
			const services = yield* Effect.context<never>()
			return Effect.fnUntraced(function* (
				httpEffect: Effect.Effect<unknown, unknown, unknown>,
				options: {
					readonly endpoint: {
						readonly name: string
						readonly method: string
						readonly annotations: Context.Context<never>
					}
					readonly group: {
						readonly identifier: string
						readonly annotations: Context.Context<never>
					}
				},
			) {
				const requirements = Option.orElse(
					Context.getOption(options.endpoint.annotations, Required),
					() =>
						Option.map(
							Context.getOption(options.group.annotations, GroupRequired),
							(rules) =>
								options.endpoint.method === "GET" ? rules.read : rules.write,
						),
				)
				if (Option.isNone(requirements)) {
					return yield* Effect.die(
						new Error(
							`The endpoint ${options.group.identifier}.${options.endpoint.name} does not say what it needs. Give it the HttpApi.Required annotation.`,
						),
					)
				}
				for (const requirement of requirements.value) {
					if (requirement.load === undefined) {
						yield* service.check({
							action: requirement.action,
							kind: requirement.kind,
						} as never)
					} else {
						const params = yield* HttpRouter.params
						const value = yield* Effect.provideContext(
							requirement.load(params),
							services,
						)
						yield* service.check({
							action: requirement.action,
							resource: value,
						} as never)
					}
				}
				return yield* httpEffect
			})
		}),
	)
