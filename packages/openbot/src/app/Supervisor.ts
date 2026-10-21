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
import { Backend } from "./Backend.ts"
import { InstanceWork } from "../execution/InstanceWork.ts"
import { ExecutionFence, type Options } from "../execution/ExecutionFence.ts"
import * as InstanceControl from "../execution/InstanceControl.ts"
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
 * many services, so a change rebuilds the app only after current work drains.
 * The old executor stops before its replacement starts.
 * Every other setting is read on each request, so it needs no new app.
 */
export const layer = <E, R>(options: {
	readonly development: boolean
	readonly execution?: Options | undefined
	readonly app: (auth: Configuration) => Layer.Layer<Backend, E, R>
}) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const settings = yield* Settings
			const work = yield* InstanceWork
			const fence = yield* ExecutionFence
			let reloading = false
			let activeRequests = 0
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
					return { key, scope, handler, backend: Context.get(context, Backend) }
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
					if (Option.isNone(running))
						return Option.some(yield* build(auth, key))
					// An operator's deployment pause owns the instance until explicitly resumed.
					if (
						(yield* work.status).quiesced ||
						(yield* fence.status).quiesced ||
						activeRequests > 0
					)
						return running
					reloading = true
					return yield* Effect.acquireUseRelease(
						work.pause,
						() =>
							replaceDrained({
								current: running.value,
								idle: InstanceControl.inspect(
									running.value.backend,
									options.execution,
								).pipe(Effect.map((state) => state.idle)),
								stop: (old) => Scope.close(old.scope, Exit.void),
								start: build(auth, key),
							}),
						(release) => release,
					).pipe(
						Effect.ensuring(
							Effect.sync(() => {
								reloading = false
							}),
						),
					)
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

			const handler = Effect.acquireUseRelease(
				Effect.sync(() => {
					if (reloading) return false
					activeRequests++
					return true
				}),
				(admitted) =>
					admitted
						? Effect.flatMap(SynchronizedRef.get(current), (running) =>
								Option.match(running, {
									onNone: () => waitingForSetup,
									onSome: (running) => running.handler,
								}),
							)
						: Effect.succeed(HttpServerResponse.empty({ status: 503 })),
				(admitted) =>
					Effect.sync(() => {
						if (admitted) activeRequests--
					}),
			)
			return HttpServer.serve(handler, HttpMiddleware.logger).pipe(
				HttpServer.withLogAddress,
			)
		}),
	)

/** Never return an executor after its scope has closed, including when startup fails. */
export const replaceDrained = <A, E, R, E2, R2>(input: {
	readonly current: A
	readonly idle: Effect.Effect<boolean, E2, R2>
	readonly stop: (current: A) => Effect.Effect<void>
	readonly start: Effect.Effect<A, E, R>
}) =>
	Effect.gen(function* () {
		const idle = yield* input.idle.pipe(
			Effect.catchCause(() => Effect.succeed(false)),
		)
		if (!idle) return Option.some(input.current)
		return yield* Effect.andThen(input.stop(input.current), input.start).pipe(
			Effect.asSome,
			Effect.catchCause((cause) =>
				Effect.as(
					Effect.logError(
						"OpenBot stopped the old app but could not start its replacement. Requests remain unavailable until startup succeeds.",
						cause,
					),
					Option.none<A>(),
				),
			),
		)
	}).pipe(Effect.uninterruptible)
