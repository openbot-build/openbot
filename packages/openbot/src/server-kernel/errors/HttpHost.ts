import { OpenBotApi, service } from "@openbot-build/api"
import {
	Array as Arr,
	Context,
	Duration,
	Effect,
	FiberSet,
	FileSystem,
	HashMap,
	HashSet,
	Layer,
	Option,
	Path,
	Ref,
	References,
	Schema,
	type Scope,
	Tracer,
	type Types,
} from "effect"
import type { NonEmptyReadonlyArray } from "effect/Array"
import {
	Etag,
	HttpPlatform,
	HttpRouter,
	HttpServerError,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"
import {
	HttpApi,
	HttpApiBuilder,
	type HttpApiGroup,
	HttpApiScalar,
	OpenApi,
} from "effect/http-api"
import { featureUnavailable } from "./HttpBoundary.ts"

/** The groups of the contract. */
type Groups = (typeof OpenBotApi)["groups"][keyof (typeof OpenBotApi)["groups"]]
/** The name of a group of the contract, such as `bots`. */
export type GroupId = HttpApiGroup.Identifier<Groups>
/** The services that `HttpApiBuilder.group` makes for these groups. */
export type GroupServices<Id extends GroupId> = HttpApiGroup.ToService<
	"openbot-api",
	HttpApiGroup.WithIdentifier<Groups, Id>
>
/** The services of the HTTP server that every router needs. */
type Platform =
	Etag.Generator | HttpPlatform.HttpPlatform | FileSystem.FileSystem | Path.Path
/**
 * What a mount needs from its caller. The host gives the router and the
 * platform. The route markers stay, so `HttpRouter.serve` asks for the services
 * of each request as it does for its own routes.
 */
type Needs<R> = Exclude<R, HttpRouter.HttpRouter | Platform>
/** A failure that a route does not handle. The server turns it into an answer. */
type RouteFailure = Types.unhandled
/** The routes of one mount, as one handler. */
type Handle = Effect.Effect<
	HttpServerResponse.HttpServerResponse,
	RouteFailure,
	HttpServerRequest.HttpServerRequest | Scope.Scope
>

/** A group, or a set of routes with this name, has a mount already. */
export class MountConflict extends Schema.TaggedError<
	MountConflict,
	{ readonly brand: unique symbol }
>()("MountConflict", {
	/** The group, or the name of the routes, that has a mount already. */
	mount: Schema.String,
}) {}

export interface Service {
	/** Serves these groups of the contract until the current scope closes. */
	readonly mount: <const Ids extends NonEmptyReadonlyArray<GroupId>, E, R>(
		ids: Ids,
		handlers: Layer.Layer<GroupServices<Ids[number]>, E, R>,
	) => Effect.Effect<void, E | MountConflict, Needs<R> | Scope.Scope>
	/**
	 * Serves routes outside the contract until the current scope closes. A
	 * contract route always wins. With `last`, every other route wins over these
	 * routes, also for `HEAD`. Use it for routes that OpenBot does not own.
	 */
	readonly mountRoutes: <E, R>(
		name: string,
		routes: Layer.Layer<never, E, R>,
		options?: { readonly last?: boolean | undefined },
	) => Effect.Effect<void, E | MountConflict, Needs<R> | Scope.Scope>
	/** The groups that have a mount now. */
	readonly mounted: Effect.Effect<HashSet.HashSet<string>>
}

export class HttpHost extends Context.Service<HttpHost, Service>()(
	"@openbot-build/openbot/server-kernel/errors/HttpHost",
) {}

/** Requests get this long to end when their mount closes. Then they are interrupted. */
export const drainTime = Duration.seconds(10)

/**
 * `HttpApiBuilder.group` keeps the context of its build and puts it over the
 * context of each request (effect HttpApiBuilder.ts:164, :1058). Without these
 * keys, a request keeps its own trace parent and its log annotations, such as
 * `requestId`.
 */
const withoutRequestOwned = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	Effect.updateContext(
		effect,
		(context: Context.Context<R>) =>
			// These keys are references with a default value, so a context without them still gives R.
			Context.omit(
				Tracer.ParentSpan,
				References.CurrentLogAnnotations,
				References.CurrentLogSpans,
			)(context) as Context.Context<R>,
	)

const isRouteNotFound = (error: unknown): boolean =>
	HttpServerError.isHttpServerError(error) &&
	error.reason._tag === "RouteNotFound"

/**
 * Waits for the requests of a mount, then interrupts the rest. The time limit
 * covers only the wait. An interrupt waits for the end of an uninterruptible
 * part, such as a route with `uninterruptible: true`, so a stuck route of this
 * kind makes the close wait with it.
 */
const drain = (requests: FiberSet.FiberSet<unknown, unknown>) =>
	FiberSet.awaitEmpty(requests).pipe(
		// A finalizer runs without interruption. The time limit can stop only an interruptible wait.
		Effect.interruptible,
		Effect.timeoutOption(drainTime),
		Effect.andThen(FiberSet.clear(requests)),
	)

/** The routes of a router as one handler. */
const handleOf = (router: HttpRouter.HttpRouter): Handle =>
	// @effect-diagnostics-next-line anyUnknownInErrorContext:off unsafeEffectTypeAssertion:off -- A router has no failure type. The server turns each failure into an answer.
	router.asHttpEffect() as Handle

interface RawMount {
	readonly name: string
	readonly handle: Handle
	/** Every other route wins over the routes of this mount. */
	readonly last: boolean
}

const make = Effect.gen(function* () {
	const server = yield* HttpRouter.HttpRouter
	const platform: Context.Context<Platform> = Context.pick(
		Etag.Generator,
		HttpPlatform.HttpPlatform,
		FileSystem.FileSystem,
		Path.Path,
	)(yield* Effect.context<Platform>())
	const groups = yield* Ref.make(HashMap.empty<string, Handle>())
	/**
	 * Newest first in each part, so a later static route wins over an older
	 * wildcard. Mounts with `last` come after all the others, so a wildcard of
	 * theirs cannot take a route of OpenBot.
	 */
	const raw = yield* Ref.make<ReadonlyArray<RawMount>>([])

	/**
	 * Builds routes into a router of their own. `HttpRouter.toHttpEffect` cannot
	 * do this inside `HttpRouter.serve`: it builds the shared `HttpRouter.layer`
	 * value with a child of the current memo map. The server build has that
	 * value in the parent map already, so the routes would go into the server
	 * router. `Layer.fresh` makes sure that a route layer the server build made
	 * already still adds its routes here.
	 */
	const attach = <E, R>(routes: Layer.Layer<never, E, R>) =>
		Effect.gen(function* () {
			const requests = yield* FiberSet.make<unknown, unknown>()
			const closing = yield* Ref.make(false)
			// A router with no routes answers RouteNotFound, as if these routes are gone.
			const gone = handleOf(yield* HttpRouter.make)
			// Each request that one of these routes takes joins the set, so the mount can wait for it.
			// After the close starts, a route acts as if it is gone, so no request runs against closed layers.
			// The check and the add are in one step, so no request can come in between them.
			const track = yield* Layer.build(
				HttpRouter.middleware((effect) =>
					Effect.withFiber((fiber) => {
						if (Ref.getUnsafe(closing)) return gone
						FiberSet.addUnsafe(requests, fiber)
						return effect
					}),
				).layer,
			)
			const router = yield* HttpRouter.make
			yield* Layer.build(Layer.fresh(routes)).pipe(
				Effect.provideContext(
					Context.add(
						Context.merge(platform, track),
						HttpRouter.HttpRouter,
						router,
					),
				),
				withoutRequestOwned,
			)
			// Finalizers run in reverse order: the drain runs before the routes close.
			yield* Effect.addFinalizer(() =>
				Effect.andThen(Ref.set(closing, true), drain(requests)),
			)
			return { handle: handleOf(router) }
		})

	const dispatch = (id: string): Handle =>
		Effect.flatMap(Ref.get(groups), (mounted) =>
			Option.match(HashMap.get(mounted, id), {
				onNone: () => featureUnavailable(id),
				// The contract route matched, so the routes of the mount do too. A miss means that the mount is closing.
				onSome: Effect.catchIf(isRouteNotFound, () => featureUnavailable(id)),
			}),
		)

	// The routes that never change: every endpoint of the contract and its documents.
	const fixed = yield* HttpRouter.make
	let table: ReadonlyArray<HttpRouter.Route<RouteFailure>> = []
	HttpApi.reflect(OpenBotApi, {
		onGroup: () => undefined,
		onEndpoint: ({ group, endpoint }) => {
			table = Arr.append(
				table,
				HttpRouter.route(
					endpoint.method,
					// The contract test keeps each path plain, so it is the router path (effect HttpApiBuilder.ts:1074).
					endpoint.path as HttpRouter.PathInput,
					dispatch(group.identifier),
					// The route of the mount decides if the request can be interrupted (effect HttpRouter.ts:254).
					{ uninterruptible: true },
				),
			)
		},
	})
	yield* fixed.addAll(table)
	const document = yield* Effect.cached(
		Effect.sync(() =>
			HttpServerResponse.jsonUnsafe(OpenApi.fromApi(OpenBotApi)),
		),
	)
	yield* fixed.add("GET", service.openapi, document)
	yield* Layer.build(
		HttpApiScalar.layer(OpenBotApi, { path: service.documentation }),
	).pipe(Effect.provideService(HttpRouter.HttpRouter, fixed))
	const fixedHandle = handleOf(fixed)

	const tryRaw = (mounts: ReadonlyArray<RawMount>, last: Handle): Handle =>
		Arr.matchLeft(mounts, {
			onEmpty: () => last,
			onNonEmpty: (head, tail) =>
				head.handle.pipe(
					Effect.catchIf(isRouteNotFound, () => tryRaw(tail, last)),
				),
		})
	yield* server.add(
		"*",
		"*",
		Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest
			const mounts = yield* Ref.get(raw)
			const owned = Arr.filter(mounts, (mount) => !mount.last)
			const last = Arr.filter(mounts, (mount) => mount.last)
			const lastOf = (error: RouteFailure) => tryRaw(last, Effect.fail(error))
			// The old single router had only the Better Auth wildcard for HEAD, so raw routes get HEAD first.
			if (request.method === "HEAD")
				return yield* tryRaw(
					owned,
					fixedHandle.pipe(Effect.catchIf(isRouteNotFound, lastOf)),
				)
			return yield* fixedHandle.pipe(
				Effect.catchIf(isRouteNotFound, (error) =>
					tryRaw(owned, lastOf(error)),
				),
			)
		}),
		{ uninterruptible: true },
	)

	return HttpHost.of({
		mount: <const Ids extends NonEmptyReadonlyArray<GroupId>, E, R>(
			ids: Ids,
			handlers: Layer.Layer<GroupServices<Ids[number]>, E, R>,
		) =>
			Effect.gen(function* () {
				const api = HttpApi.make("openbot-api").add(
					...Arr.map(ids, (id) => OpenBotApi.groups[id]),
				)
				// The sub-API holds only the groups in `ids`, and `handlers` gives exactly their services.
				// TypeScript cannot follow this, because `HttpApi.add` takes a tuple type.
				// @effect-diagnostics-next-line unsafeEffectTypeAssertion:off -- The sub-API needs only the services of `ids`.
				const routes = HttpApiBuilder.layer(api).pipe(
					Layer.provide(handlers),
				) as Layer.Layer<never, E, R | HttpRouter.HttpRouter | Platform>
				const { handle } = yield* attach(routes)
				yield* Effect.acquireRelease(
					Effect.flatten(
						Ref.modify(
							groups,
							(
								mounted,
							): readonly [
								Effect.Effect<void, MountConflict>,
								HashMap.HashMap<string, Handle>,
							] =>
								Option.match(
									Arr.findFirst(ids, (id) => HashMap.has(mounted, id)),
									{
										onSome: (id) => [
											Effect.fail(MountConflict.make({ mount: id })),
											mounted,
										],
										onNone: () => [
											Effect.void,
											Arr.reduce(ids, mounted, (next, id) =>
												HashMap.set(next, id, handle),
											),
										],
									},
								),
						),
					),
					() =>
						Ref.update(groups, (mounted) =>
							Arr.reduce(ids, mounted, (next, id) => HashMap.remove(next, id)),
						),
				)
			}),
		mountRoutes: (name, routes, options) =>
			Effect.gen(function* () {
				const { handle } = yield* attach(routes)
				yield* Effect.acquireRelease(
					Effect.flatten(
						Ref.modify(
							raw,
							(
								mounts,
							): readonly [
								Effect.Effect<void, MountConflict>,
								ReadonlyArray<RawMount>,
							] =>
								Arr.some(mounts, (mount) => mount.name === name)
									? [Effect.fail(MountConflict.make({ mount: name })), mounts]
									: [
											Effect.void,
											Arr.prepend(mounts, {
												name,
												handle,
												last: options?.last === true,
											}),
										],
						),
					),
					() =>
						Ref.update(
							raw,
							Arr.filter((mount) => mount.name !== name),
						),
				)
			}),
		mounted: Effect.map(Ref.get(groups), (mounted) =>
			HashSet.fromIterable(HashMap.keys(mounted)),
		),
	})
})

/** One HTTP shell for the whole contract. Mounts give it handlers while their scopes are open. */
export const layer = Layer.effect(HttpHost, make)
