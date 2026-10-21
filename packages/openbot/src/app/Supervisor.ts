import { Settings as Api } from "@openbot-build/api"
import {
	Context,
	Effect,
	Exit,
	Layer,
	Option,
	Scope,
	Stream,
	SynchronizedRef,
} from "effect"
import {
	HttpMiddleware,
	HttpRouter,
	HttpServer,
	HttpServerError,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"
import type { Configuration } from "../auth/Model.ts"
import { Settings } from "../settings/Settings.ts"
import * as Platform from "../settings/Platform.ts"
import type { Secrets } from "../secrets/Secrets.ts"

/**
 * HttpRouter marks the services that routes need with type-only `Request`
 * entries. They are not real services. The routes get those services from the
 * context that the app builds, the same way as in `HttpRouter.serve`, so the
 * marks can go. TypeScript cannot see this for a generic layer, so it needs a cast.
 */
const withoutRouteMarkers = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
	layer as unknown as Layer.Layer<A, E, HttpRouter.Request.Without<R>>

/** Answers while nobody has run `openbot setup`. Only the health check works. */
const waitingForSetup = Effect.gen(function* () {
	const request = yield* HttpServerRequest.HttpServerRequest
	return new URL(request.url, "http://openbot.invalid").pathname === "/health"
		? HttpServerResponse.jsonUnsafe({ status: "ok" })
		: HttpServerResponse.jsonUnsafe(Api.SetupRequired.make({}), {
				status: 503,
			})
})

/**
 * Serves the app that the platform settings describe.
 * The public origin, the sign-in secret and the sign-in provider are part of
 * many services, so a change to one of them builds a new app. The new app
 * takes new requests first, and then the old app stops.
 * Every other setting is read on each request, so it needs no new app.
 */
export const layer = <E, R>(options: {
	readonly development: boolean
	readonly app: (auth: Configuration) => Layer.Layer<never, E, R>
}) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const settings = yield* Settings
			const build = (auth: Configuration, key: string) =>
				Effect.gen(function* () {
					const scope = yield* Scope.make()
					// Like `HttpRouter.serve`: each request gets the services that the app built.
					const context = yield* Layer.buildWithScope(
						Layer.provideMerge(
							withoutRouteMarkers(options.app(auth)),
							HttpRouter.layer,
						),
						scope,
					).pipe(
						Effect.onExit((exit) =>
							Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void,
						),
					)
					// HttpRouter types its handler errors as unknown. The next step handles them all.
					// @effect-diagnostics-next-line anyUnknownInErrorContext:off
					const handler = Context.get(context, HttpRouter.HttpRouter)
						.asHttpEffect()
						.pipe(
							Effect.provideContext(context),
							// The router has no error type. Give each failure the response
							// that the server would send, and log the ones it would log.
							Effect.catchCause((cause) =>
								Effect.flatMap(
									HttpServerError.causeResponse(cause),
									([response, rest]) =>
										response.status >= 500
											? Effect.as(
													Effect.logError("A request failed", rest),
													response,
												)
											: Effect.succeed(response),
								),
							),
						)
					return { key, scope, handler }
				})
			type Running = Effect.Success<ReturnType<typeof build>>
			const context = yield* Effect.context<
				Effect.Services<ReturnType<typeof build>> | Secrets
			>()
			const current = yield* SynchronizedRef.make(Option.none<Running>())

			const sync = SynchronizedRef.updateEffect(current, (running) =>
				Effect.gen(function* () {
					const platform = yield* settings.platform
					if (Option.isNone(platform)) return running
					const key = Platform.appKey(platform.value.document)
					if (Option.isSome(running) && running.value.key === key)
						return running
					const auth = yield* Platform.authConfiguration({
						document: platform.value.document,
						development: options.development,
					})
					const next = yield* build(auth, key)
					if (Option.isSome(running)) {
						yield* Scope.close(running.value.scope, Exit.void)
						yield* Effect.logInfo(
							"The platform settings changed, so OpenBot started a new app.",
						)
					}
					return Option.some(next)
				}).pipe(
					Effect.provideContext(context),
					Effect.catchCause((cause) =>
						Effect.as(
							Effect.logError(
								"OpenBot could not start the app from the platform settings. It keeps the current app.",
								cause,
							),
							running,
						),
					),
				),
			)

			yield* sync
			yield* Effect.addFinalizer(() =>
				Effect.flatMap(SynchronizedRef.get(current), (running) =>
					Option.isSome(running)
						? Scope.close(running.value.scope, Exit.void)
						: Effect.void,
				),
			)
			if (Option.isNone(yield* SynchronizedRef.get(current)))
				yield* Effect.logWarning(
					"The platform has no settings yet. Run `openbot setup`. Until then, every route except /health answers with SetupRequired.",
				)
			// A missed notice must not keep an old app for ever, so also check from time to time.
			yield* Stream.merge(
				Stream.filter(settings.changes, (scope) => scope.kind === "platform"),
				Stream.tick("30 seconds"),
			).pipe(
				Stream.runForEach(() => sync),
				Effect.forkScoped,
			)

			const handler = Effect.flatMap(SynchronizedRef.get(current), (running) =>
				Option.match(running, {
					onNone: () => waitingForSetup,
					onSome: (running) => running.handler,
				}),
			)
			return HttpServer.serve(handler, HttpMiddleware.logger).pipe(
				HttpServer.withLogAddress,
			)
		}),
	)
