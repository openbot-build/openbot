/**
 * Tools to check authorization in an `effect/http-api` server.
 *
 * Each endpoint says what it needs with the {@link Required} annotation. A
 * group can give a default with {@link GroupRequired}: one list for GET
 * requests and one list for all other methods. A middleware checks the
 * requirements before the handler runs, in each group that uses it. An
 * endpoint with no annotation is a defect, so a new endpoint is closed until
 * you say what it needs. An empty list means the endpoint is open. An endpoint
 * in a group without the middleware is not checked at all.
 *
 * ```ts
 * class Authorization extends HttpApiMiddleware.Service<
 *   Authorization,
 *   { requires: Identity }
 * >()("app/Authorization", { error: HttpApi.errors }) {}
 *
 * const endpoint = HttpApiEndpoint.patch("update", "/bots/:id", { ... })
 *   .annotate(HttpApi.Required, [
 *     HttpApi.requires(Auth, "update", "Bot", (params) => Bots.find(params.id)),
 *   ])
 *
 * const bots = HttpApiGroup.make("bots").add(endpoint).middleware(Authorization)
 *
 * const AuthorizationLive = HttpApi.layer(Authorization, Auth)
 * ```
 *
 * This module is a separate entry point, `@nmnmcc/ability/HttpApi`, because
 * `effect/http-api` is not stable yet.
 *
 * @stability unstable
 * @since 0.3.0
 */
// A `load` function of a requirement is kept in an annotation, so its error
// type and its service type are erased to `unknown`. The language service
// check for `unknown` in an Effect is off here.
// @effect-diagnostics anyUnknownInErrorContext:off
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { HttpRouter } from "effect/http"
import { HttpApiSchema } from "effect/http-api"
import * as Authorizer from "./Authorizer.ts"
import type * as Domain from "./Domain.ts"
import type * as Policy from "./Policy.ts"
import * as Resource from "./Resource.ts"

/**
 * The path parameters of a request.
 *
 * @stability unstable
 * @category models
 * @since 0.5.0
 */
export type Params = Readonly<Record<string, string | undefined>>

/**
 * One check that an endpoint needs: an action on a kind of resource.
 * - With `load`, the middleware loads the resource value from the path
 *   parameters and checks the action on that value.
 * - With `within`, it makes a scope from the path parameters and checks the
 *   action on every value in the scope.
 * - With `list`, the endpoint gives a list. The handler gets the list query
 *   with `Authorizer.filter`, so the middleware checks nothing, unless
 *   `nonEmpty` is true: then it fails when the principal may act on no value
 *   in the scope.
 * - With none of them, it checks the action on every value of the kind.
 *
 * @stability unstable
 * @category models
 * @since 0.3.0
 */
export interface Requirement {
	readonly action: string
	readonly kind: string
	readonly load?: (params: Params) => Effect.Effect<object, unknown, unknown>
	readonly within?: (params: Params) => unknown
	readonly list?: { readonly nonEmpty: boolean }
}

/**
 * The checks that an endpoint needs.
 *
 * @stability unstable
 * @category annotations
 * @since 0.3.0
 */
export class Required extends Context.Service<
	Required,
	ReadonlyArray<Requirement>
>()("@nmnmcc/ability/HttpApi/Required") {}

/**
 * The checks for every endpoint of a group with no {@link Required}
 * annotation. `read` is for GET requests. `write` is for all other methods.
 *
 * @stability unstable
 * @category annotations
 * @since 0.3.0
 */
export class GroupRequired extends Context.Service<
	GroupRequired,
	{
		readonly read: ReadonlyArray<Requirement>
		readonly write: ReadonlyArray<Requirement>
	}
>()("@nmnmcc/ability/HttpApi/GroupRequired") {}

/**
 * Makes a {@link Requirement} with the types of an authorizer. The action must
 * be an action of the kind, also when the kind has a union type.
 *
 * The last argument is one of:
 * - a `load` function, which must give a value of the kind. It may fail. Its
 *   errors must be errors of the middleware, and the services that it needs
 *   must be given to {@link layer}.
 * - `{ within }`, a function from the path parameters to a scope. Use it for
 *   an act on a part of the kind, such as a new value with no id yet:
 *   `{ within: (params) => ($) => $.under("org", params.org ?? null) }`. A path
 *   parameter may be `undefined`, and a scope with `undefined` in it is a
 *   defect, so give a value for it.
 *
 * @stability unstable
 * @category constructors
 * @since 0.3.0
 */
export const requires: <
	A extends { readonly domain: Domain.Any },
	const K extends Domain.Kind<A["domain"]>,
>(
	authorizer: A,
	action: Domain.CommonAction<A["domain"], K>,
	kind: K,
	how?:
		| ((
				params: Params,
		  ) => Effect.Effect<Domain.ValueOf<A["domain"], K>, unknown, unknown>)
		| { readonly within: (params: Params) => Policy.Scope<A["domain"], K> },
) => Requirement = (_authorizer, action, kind, how) =>
	how === undefined
		? { action: action as string, kind }
		: typeof how === "function"
			? { action: action as string, kind, load: how }
			: { action: action as string, kind, within: how.within }

/**
 * Makes a {@link Requirement} for an endpoint that gives a list. The middleware
 * does not check that the principal may act on every value, because the list
 * shows only the values that it may act on. The handler gets the list query
 * with `Authorizer.filter`, with the same scope.
 *
 * When the principal may act on no value, the list is empty: that is not an
 * error, so a client does not learn that hidden values are there. With
 * `nonEmpty: true`, the middleware fails with `Forbidden` in that case.
 *
 * @stability unstable
 * @category constructors
 * @since 0.5.0
 */
export const lists: <
	A extends { readonly domain: Domain.Any },
	const K extends Domain.Kind<A["domain"]>,
>(
	authorizer: A,
	action: Domain.CommonAction<A["domain"], K>,
	kind: K,
	options?: {
		readonly within?: (params: Params) => Policy.Scope<A["domain"], K>
		readonly nonEmpty?: boolean
	},
) => Requirement = (_authorizer, action, kind, options) => ({
	action: action as string,
	kind,
	list: { nonEmpty: options?.nonEmpty ?? false },
	...(options?.within === undefined ? {} : { within: options.within }),
})

/**
 * The Schema of a `PolicyUnavailable` response. It encodes only the `_tag`, so
 * the cause does not go to the client.
 */
const PolicyUnavailableResponse = Schema.TaggedStruct(
	"PolicyUnavailable",
	{},
).pipe(
	Schema.decodeTo(
		Schema.declare(
			(u): u is Authorizer.PolicyUnavailable =>
				u instanceof Authorizer.PolicyUnavailable,
		),
		SchemaTransformation.transform({
			decode: () => Authorizer.PolicyUnavailable.make({ cause: undefined }),
			encode: () => ({ _tag: "PolicyUnavailable" as const }),
		}),
	),
)

/**
 * The errors of the middleware, with HTTP status codes: 403 for
 * `Forbidden`, 503 for `PolicyUnavailable`, and 409 for `Pending`.
 *
 * The body of a `PolicyUnavailable` response has only its `_tag`. The cause
 * may have private details, such as an error from the database, so it stays
 * on the server.
 *
 * @stability unstable
 * @category errors
 * @since 0.3.0
 */
export const errors = [
	Authorizer.Forbidden.pipe(HttpApiSchema.status(403)),
	PolicyUnavailableResponse.pipe(HttpApiSchema.status(503)),
	Authorizer.Pending.pipe(HttpApiSchema.status(409)),
] as const

const makeLayer = (
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
				const endpoint = `${options.group.identifier}.${options.endpoint.name}`
				// The requirements are checked in order. The first one that fails
				// stops the request.
				yield* Effect.forEach(
					requirements.value,
					({ action, kind, load, within, list }) => {
						if (load !== undefined) {
							return HttpRouter.params.pipe(
								Effect.flatMap((params) =>
									Effect.provideContext(load(params), services),
								),
								// The check is for the kind of the requirement. A value of
								// another kind is a mistake in `load`, and the check must
								// not pass with the rules of that other kind.
								Effect.filterOrElse(
									(value) => Resource.kindOf(value) === kind,
									() =>
										Effect.die(
											new Error(
												`The load function of ${endpoint} gave a value that is not a ${kind}`,
											),
										),
								),
								Effect.flatMap((value) =>
									service.check({ action, resource: value } as never),
								),
							)
						}
						const target =
							within === undefined
								? Effect.succeed({ action, kind } as never)
								: Effect.map(
										HttpRouter.params,
										(params) =>
											({ action, kind, within: within(params) }) as never,
									)
						if (list === undefined) {
							return Effect.flatMap(target, (value) => service.check(value))
						}
						// A list endpoint may give an empty list, unless it must not.
						return list.nonEmpty
							? target.pipe(
									Effect.flatMap((value) => service.coverage(value)),
									Effect.filterOrElse(
										(covered) =>
											(covered as { readonly _tag: string })._tag !== "None",
										() =>
											Effect.fail(Authorizer.Forbidden.make({ action, kind })),
									),
								)
							: Effect.void
					},
					{ discard: true },
				)
				return yield* httpEffect
			})
		}),
	)

/**
 * Makes the layer of an authorization middleware. The middleware reads the
 * {@link Required} and {@link GroupRequired} annotations and checks each
 * requirement with the authorizer.
 *
 * The layer takes the authorizer when it is built. The middleware must
 * require the services of the authorizer, such as the identity of the
 * caller. `R` is the type of the services that the `load` functions need. The
 * layer takes them when it is built too.
 *
 * @stability unstable
 * @category layers
 * @since 0.3.0
 */
export const layer: <
	Self,
	Id extends string,
	A extends Authorizer.AnyServiceClass,
	R = never,
>(
	middleware: Context.ServiceClass<Self, Id, any>,
	authorizer: A,
) => Layer.Layer<
	Self,
	never,
	(A extends Context.Key<infer I, any> ? I : never) | R
> = makeLayer as never
