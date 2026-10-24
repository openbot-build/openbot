/**
 * Tools to check authorization in an `effect/http-api` server.
 *
 * Each endpoint says what it needs with the {@link Required} annotation. A
 * group can give a default with {@link GroupRequired}: one list for GET
 * requests and one list for all other methods. A middleware checks the
 * requirements before the handler runs. An endpoint with no annotation is a
 * defect, so a new endpoint is closed until you say what it needs. An empty
 * list means the endpoint is open.
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
 * const AuthorizationLive = HttpApi.layer(Authorization, Auth)
 * ```
 *
 * This module is a separate entry point, `@nmnmcc/ability/HttpApi`, because
 * `effect/http-api` is not stable yet.
 *
 * @stability unstable
 * @since 0.3.0
 */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import { HttpApiSchema } from "effect/http-api"
import * as Authorizer from "./Authorizer.ts"
import type * as Domain from "./Domain.ts"
import * as internal from "./internal/httpApi.ts"

/**
 * One check that an endpoint needs: an action on a kind of resource. With
 * `load`, the middleware loads the resource value from the path parameters
 * and checks the action on that value. Without `load`, it checks the action
 * on the kind.
 *
 * @stability unstable
 * @category models
 * @since 0.3.0
 */
export interface Requirement {
	readonly action: string
	readonly kind: string
	readonly load?: (
		params: Readonly<Record<string, string | undefined>>,
	) => Effect.Effect<object, unknown, unknown>
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
 * be an action of the kind, and `load` must give a value of the kind.
 *
 * `load` may fail. Its errors must be errors of the middleware, and the
 * services that it needs must be given to {@link layer}.
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
	action: Domain.ActionOf<A["domain"], K>,
	kind: K,
	load?: (
		params: Readonly<Record<string, string | undefined>>,
	) => Effect.Effect<Domain.ValueOf<A["domain"], K>, unknown, unknown>,
) => Requirement = internal.requires

/**
 * The errors of the middleware, with HTTP status codes: 403 for
 * `Forbidden`, 503 for `PolicyUnavailable`, and 409 for `Pending`.
 *
 * @stability unstable
 * @category errors
 * @since 0.3.0
 */
export const errors = [
	Authorizer.Forbidden.pipe(HttpApiSchema.status(403)),
	Authorizer.PolicyUnavailable.pipe(HttpApiSchema.status(503)),
	Authorizer.Pending.pipe(HttpApiSchema.status(409)),
] as const

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
> = internal.layer as never
