import { assert, it } from "@effect/vitest"
import {
	NodeCrypto,
	NodeHttpServer,
	NodeServices,
	NodeSocket,
} from "@effect/platform-node"
import {
	Array as Arr,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Ref,
	References,
	Schema,
	Scope,
	String as Str,
	Tracer,
} from "effect"
import { identity } from "effect/Function"
import { TestClock } from "effect/testing"
import {
	HttpClient,
	HttpRouter,
	HttpServer,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"
import { HttpApiBuilder, HttpApiClient, OpenApi } from "effect/http-api"
import { Socket } from "effect/socket"
import { FailureApi, OpenBotApi, service } from "@openbot-build/api"
import { Execution } from "@openbot-build/domain"
import * as HttpHost from "@openbot-build/server-kernel/errors/HttpHost"
import { Records } from "@openbot-build/server-kernel/errors/Records"
import * as ErrorReporting from "@openbot-build/server-kernel/errors/Reporting"

/** An error record stub that keeps the route of each record. */
const recorder = Effect.gen(function* () {
	const routes = yield* Ref.make<ReadonlyArray<unknown>>([])
	const layer = Layer.succeed(
		Records,
		Records.of({
			record: (_cause, category) =>
				Effect.gen(function* () {
					const annotations = yield* References.CurrentLogAnnotations
					yield* Ref.update(routes, Arr.append(annotations["route"]))
					return { errorId: Execution.ErrorId.make("test-error-id"), category }
				}),
		}),
	)
	return { layer, routes: Ref.get(routes) }
})

/** A real test server with the host and the error log, and no mounts. */
const server = (records: Layer.Layer<Records>) =>
	HttpRouter.serve(
		ErrorReporting.layerHttp.pipe(Layer.provideMerge(HttpHost.layer)),
		{ disableLogger: true, disableListenLog: true },
	).pipe(
		Layer.provide(records),
		Layer.provideMerge(NodeHttpServer.layerTest),
		// The error logs make their request ids with the SecureRandom service.
		Layer.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
	)

// The test boundary passes every answer and failure on as it is.
const boundary = Layer.succeed(FailureApi.FailureBoundary, identity)

/** The health group, with the answer of `getHealth` from the test. */
const health = (
	answer: Effect.Effect<{ readonly status: "ok" }> = Effect.succeed({
		status: "ok",
	}),
) =>
	HttpApiBuilder.group(OpenBotApi, "health", (handlers) =>
		handlers
			.handle("getService", () => Effect.succeed(service))
			.handle("getHealth", () => answer),
	).pipe(Layer.provide(boundary))

/** Runs a mount in a scope that the test closes. */
const open = <E, R>(mount: Effect.Effect<void, E, R>) =>
	Effect.gen(function* () {
		const scope = yield* Scope.make()
		yield* Scope.provide(mount, scope)
		return scope
	})

const close = (scope: Scope.Closeable) => Scope.close(scope, Exit.void)

const get = (path: string) =>
	Effect.flatMap(HttpClient.get(path), (response) =>
		Effect.map(response.text, (body) => ({
			status: response.status,
			headers: response.headers,
			body,
		})),
	)

const head = (path: string) =>
	Effect.map(HttpClient.head(path), (response) => response.status)

const text = (body: string) => HttpServerResponse.text(body)

it.live(
	"a group with no mount answers FeatureUnavailable, and the error log skips it",
	() =>
		Effect.gen(function* () {
			const records = yield* recorder
			yield* Effect.gen(function* () {
				const answer = yield* get("/health")
				assert.strictEqual(answer.status, 503)
				assert.strictEqual(answer.headers["retry-after"], "5")
				assert.strictEqual(answer.headers[FailureApi.featureHeader], "health")
				const client = yield* HttpApiClient.group(OpenBotApi, {
					group: "health",
					httpClient: yield* HttpClient.HttpClient,
				})
				const failure = yield* Effect.flip(client.getHealth())
				assert.ok(Schema.is(FailureApi.FeatureUnavailable)(failure))
				assert.strictEqual(
					Schema.is(FailureApi.FeatureUnavailable)(failure)
						? failure.feature
						: undefined,
					"health",
				)
				assert.strictEqual((yield* records.routes).length, 0)
			}).pipe(Effect.provide(server(records.layer)))
		}),
)

it.live(
	"a group answers while its mount is open, and FeatureUnavailable after it closes",
	() =>
		Effect.gen(function* () {
			const records = yield* recorder
			yield* Effect.gen(function* () {
				const host = yield* HttpHost.HttpHost
				const scope = yield* open(host.mount(["health"], health()))
				const answer = yield* get("/health")
				assert.strictEqual(answer.status, 200)
				assert.strictEqual(answer.body, '{"status":"ok"}')
				assert.deepStrictEqual(Arr.fromIterable(yield* host.mounted), [
					"health",
				])
				yield* close(scope)
				assert.strictEqual((yield* get("/health")).status, 503)
				assert.strictEqual(Arr.fromIterable(yield* host.mounted).length, 0)
			}).pipe(Effect.provide(server(records.layer)))
		}),
)

it.live("a group can be mounted again after its mount closes", () =>
	Effect.gen(function* () {
		const records = yield* recorder
		yield* Effect.gen(function* () {
			const host = yield* HttpHost.HttpHost
			const first = yield* open(host.mount(["health"], health()))
			yield* close(first)
			const second = yield* open(host.mount(["health"], health()))
			assert.strictEqual((yield* get("/health")).status, 200)
			yield* close(second)
		}).pipe(Effect.provide(server(records.layer)))
	}),
)

it.live("a second mount of the same group fails with MountConflict", () =>
	Effect.gen(function* () {
		const records = yield* recorder
		yield* Effect.gen(function* () {
			const host = yield* HttpHost.HttpHost
			const first = yield* open(host.mount(["health"], health()))
			const scope = yield* Scope.make()
			const conflict = yield* Effect.flip(
				Scope.provide(host.mount(["health"], health()), scope),
			)
			assert.strictEqual(conflict._tag, "MountConflict")
			assert.strictEqual(conflict.mount, "health")
			yield* close(scope)
			// The failed mount did not take the group from the first mount.
			assert.strictEqual((yield* get("/health")).status, 200)

			const routes = HttpRouter.add("GET", "/internal/x", text("raw"))
			const raw = yield* open(host.mountRoutes("raw", routes))
			const other = yield* Scope.make()
			const rawConflict = yield* Effect.flip(
				Scope.provide(host.mountRoutes("raw", routes), other),
			)
			assert.strictEqual(rawConflict._tag, "MountConflict")
			assert.strictEqual(rawConflict.mount, "raw")
			yield* close(other)
			yield* close(raw)
			yield* close(first)
		}).pipe(Effect.provide(server(records.layer)))
	}),
)

it.live("a route outside the contract cannot take a contract path", () =>
	Effect.gen(function* () {
		const records = yield* recorder
		yield* Effect.gen(function* () {
			const host = yield* HttpHost.HttpHost
			const shadow = yield* open(
				host.mountRoutes(
					"shadow",
					HttpRouter.add("GET", "/health", text("raw")),
				),
			)
			const unmounted = yield* get("/health")
			assert.strictEqual(unmounted.status, 503)
			assert.strictEqual(unmounted.headers[FailureApi.featureHeader], "health")
			const group = yield* open(host.mount(["health"], health()))
			const mounted = yield* get("/health")
			assert.strictEqual(mounted.status, 200)
			assert.strictEqual(mounted.body, '{"status":"ok"}')
			yield* close(group)
			yield* close(shadow)
		}).pipe(Effect.provide(server(records.layer)))
	}),
)

it.live(
	"routes outside the contract answer their paths, and other paths answer 404",
	() =>
		Effect.gen(function* () {
			const records = yield* recorder
			yield* Effect.gen(function* () {
				const host = yield* HttpHost.HttpHost
				const raw = yield* open(
					host.mountRoutes(
						"raw",
						HttpRouter.add("GET", "/internal/x", text("raw")),
					),
				)
				const answer = yield* get("/internal/x")
				assert.strictEqual(answer.status, 200)
				assert.strictEqual(answer.body, "raw")
				assert.strictEqual((yield* get("/nope")).status, 404)
				assert.strictEqual((yield* records.routes).length, 0)
				yield* close(raw)
				assert.strictEqual((yield* get("/internal/x")).status, 404)
			}).pipe(Effect.provide(server(records.layer)))
		}),
)

it.live(
	"HEAD gives raw routes the first chance, then the GET handler of the contract",
	() =>
		Effect.gen(function* () {
			const records = yield* recorder
			yield* Effect.gen(function* () {
				const host = yield* HttpHost.HttpHost
				const auth = yield* open(
					host.mountRoutes(
						"auth",
						HttpRouter.add(
							"*",
							"/auth/*",
							HttpServerResponse.empty({ status: 204 }),
						),
					),
				)
				const group = yield* open(host.mount(["health"], health()))
				assert.strictEqual(yield* head("/auth/anything"), 204)
				assert.strictEqual(yield* head("/health"), 200)
				assert.strictEqual(yield* head("/docs"), 200)
				yield* close(group)
				yield* close(auth)
			}).pipe(Effect.provide(server(records.layer)))
		}),
)

it.live(
	"a wildcard of routes that come last does not take the routes of OpenBot",
	() =>
		Effect.gen(function* () {
			const records = yield* recorder
			yield* Effect.gen(function* () {
				const host = yield* HttpHost.HttpHost
				const auth = yield* open(
					host.mountRoutes(
						"auth",
						HttpRouter.add("*", "/auth/*", text("auth")),
					),
				)
				const group = yield* open(host.mount(["health"], health()))
				// The routes of the embedder come after the others, though they are the newest mount.
				const user = yield* open(
					host.mountRoutes("user", HttpRouter.add("*", "/*", text("user")), {
						last: true,
					}),
				)
				const rpc = yield* open(
					host.mountRoutes(
						"rpc",
						HttpRouter.add("POST", "/internal/rpc", text("rpc")),
					),
				)
				assert.strictEqual((yield* get("/auth/sign-in/x")).body, "auth")
				assert.strictEqual((yield* get("/health")).body, '{"status":"ok"}')
				assert.strictEqual(yield* head("/health"), 200)
				const call = yield* Effect.flatMap(
					HttpClient.post("/internal/rpc"),
					(response) => response.text,
				)
				assert.strictEqual(call, "rpc")
				assert.strictEqual((yield* get("/other")).body, "user")
				yield* close(rpc)
				yield* close(user)
				yield* close(group)
				yield* close(auth)
			}).pipe(Effect.provide(server(records.layer)))
		}),
)

it.live(
	"a handler sees the request id of its request, not the log annotations of the mount",
	() =>
		Effect.gen(function* () {
			const records = yield* recorder
			const seen = yield* Ref.make<
				Option.Option<{
					readonly annotations: Readonly<Record<string, unknown>>
					readonly parent: Option.Option<Tracer.AnySpan>
				}>
			>(Option.none())
			const answer = Effect.gen(function* () {
				const annotations = yield* References.CurrentLogAnnotations
				const context = yield* Effect.context<never>()
				yield* Ref.set(
					seen,
					Option.some({
						annotations,
						parent: Context.getOption(context, Tracer.ParentSpan),
					}),
				)
				return { status: "ok" as const }
			})
			yield* Effect.gen(function* () {
				const host = yield* HttpHost.HttpHost
				const scope = yield* open(
					host
						.mount(["health"], health(answer))
						.pipe(
							Effect.annotateLogs({ build: "startup" }),
							Effect.withSpan("startup"),
						),
				)
				assert.strictEqual((yield* get("/health")).status, 200)
				const result = Option.getOrThrow(yield* Ref.get(seen))
				assert.match(
					String(result.annotations["requestId"]),
					/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
				)
				assert.strictEqual(result.annotations["build"], undefined)
				assert.ok(
					Option.match(result.parent, {
						onNone: () => true,
						onSome: (span) => span._tag !== "Span" || span.name !== "startup",
					}),
				)
				yield* close(scope)
			}).pipe(Effect.provide(server(records.layer)))
		}),
)

it.live("the error log names the route of the mount", () =>
	Effect.gen(function* () {
		const records = yield* recorder
		yield* Effect.gen(function* () {
			const host = yield* HttpHost.HttpHost
			const scope = yield* open(
				host.mountRoutes(
					"fault",
					HttpRouter.add("GET", "/fault/:id", Effect.die("test fault")),
				),
			)
			assert.strictEqual((yield* get("/fault/one")).status, 500)
			assert.deepStrictEqual(yield* records.routes, ["/fault/:id"])
			yield* close(scope)
		}).pipe(Effect.provide(server(records.layer)))
	}),
)

it.live("the OpenAPI document is the document of the whole contract", () =>
	Effect.gen(function* () {
		const records = yield* recorder
		yield* Effect.gen(function* () {
			const document = yield* get(service.openapi)
			assert.strictEqual(document.status, 200)
			const expected = yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.Unknown),
			)(OpenApi.fromApi(OpenBotApi))
			assert.strictEqual(document.body, expected)
			const page = yield* get(service.documentation)
			assert.strictEqual(page.status, 200)
			assert.include(String(page.headers["content-type"]), "text/html")
		}).pipe(Effect.provide(server(records.layer)))
	}),
)

it.live("a request that is running ends before its mount closes", () =>
	Effect.gen(function* () {
		const records = yield* recorder
		const started = yield* Deferred.make<void>()
		const release = yield* Deferred.make<void>()
		yield* Effect.gen(function* () {
			const host = yield* HttpHost.HttpHost
			const scope = yield* open(
				host.mountRoutes(
					"slow",
					HttpRouter.add(
						"GET",
						"/slow",
						Deferred.succeed(started, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
							Effect.as(HttpServerResponse.text("done")),
						),
					),
				),
			)
			const request = yield* Effect.forkChild(get("/slow"))
			yield* Deferred.await(started)
			const closing = yield* Effect.forkChild(close(scope))
			yield* Effect.sleep("100 millis")
			assert.strictEqual(closing.pollUnsafe(), undefined)
			yield* Deferred.succeed(release, undefined)
			const answer = yield* Fiber.join(request)
			assert.strictEqual(answer.status, 200)
			assert.strictEqual(answer.body, "done")
			yield* Fiber.join(closing)
		}).pipe(Effect.provide(server(records.layer)))
	}),
)

it.effect("a request that runs longer than the drain time is interrupted", () =>
	Effect.gen(function* () {
		const records = yield* recorder
		const started = yield* Deferred.make<void>()
		const interrupted = yield* Deferred.make<void>()
		yield* Effect.gen(function* () {
			const host = yield* HttpHost.HttpHost
			const scope = yield* open(
				host.mountRoutes(
					"slow",
					HttpRouter.add(
						"GET",
						"/slow",
						Deferred.succeed(started, undefined).pipe(
							Effect.andThen(Effect.never),
							Effect.onInterrupt(() =>
								Deferred.succeed(interrupted, undefined),
							),
						),
					),
				),
			)
			const request = yield* Effect.forkChild(Effect.exit(get("/slow")))
			yield* Deferred.await(started)
			const closing = yield* Effect.forkChild(close(scope))
			yield* TestClock.adjust("9 seconds")
			assert.strictEqual(closing.pollUnsafe(), undefined)
			assert.isFalse(yield* Deferred.isDone(interrupted))
			yield* TestClock.adjust("1 second")
			yield* Deferred.await(interrupted)
			yield* Fiber.join(closing)
			yield* Fiber.join(request)
		}).pipe(Effect.provide(server(records.layer)))
	}),
)

it.live(
	"an open WebSocket closes when its mount closes",
	() =>
		Effect.gen(function* () {
			const records = yield* recorder
			const started = yield* Deferred.make<void>()
			yield* Effect.gen(function* () {
				const host = yield* HttpHost.HttpHost
				const address = (yield* HttpServer.HttpServer).address
				const scope = yield* open(
					host.mountRoutes(
						"socket",
						HttpRouter.add(
							"GET",
							"/socket",
							Effect.gen(function* () {
								const request = yield* HttpServerRequest.HttpServerRequest
								const socket = yield* request.upgrade
								const reader = yield* socket.reader
								yield* Deferred.succeed(started, undefined)
								return yield* Effect.forever(reader.pull)
							}).pipe(
								// The test needs no typed failure from this route.
								Effect.orDie,
							),
						),
					),
				)
				const url = Str.replace(
					/^http/,
					"ws",
				)(HttpServer.formatAddress(address))
				const client = yield* Effect.gen(function* () {
					const socket = yield* Socket.makeWebSocket(url + "/socket")
					const reader = yield* socket.reader
					return yield* Effect.flip(Effect.forever(reader.pull))
				}).pipe(
					Effect.scoped,
					Effect.provide(NodeSocket.layerWebSocketConstructor),
					Effect.forkChild,
				)
				yield* Deferred.await(started)
				yield* Effect.forkChild(close(scope))
				const failure = yield* Fiber.join(client).pipe(
					Effect.timeout("15 seconds"),
				)
				assert.ok(Socket.isSocketError(failure))
			}).pipe(Effect.provide(server(records.layer)))
		}),
	{ timeout: 30_000 },
)

it.live("the server stops taking requests before the mounts close", () =>
	Effect.gen(function* () {
		const records = yield* recorder
		const late = yield* Ref.make<Option.Option<boolean>>(Option.none())
		// The finalizer of the routes asks the server for one more answer.
		const routes = Layer.mergeAll(
			Layer.effectDiscard(
				Effect.gen(function* () {
					const client = yield* HttpClient.HttpClient
					yield* Effect.addFinalizer(() =>
						client.get("/raw").pipe(
							Effect.timeout("5 seconds"),
							Effect.exit,
							Effect.flatMap((exit) =>
								Ref.set(late, Option.some(Exit.isSuccess(exit))),
							),
						),
					)
				}),
			),
			HttpRouter.add("GET", "/raw", text("raw")),
		)
		const mounts = Layer.effectDiscard(
			Effect.flatMap(HttpHost.HttpHost, (host) =>
				host.mountRoutes("raw", routes),
			),
		)
		const app = HttpRouter.serve(
			Layer.mergeAll(ErrorReporting.layerHttp, mounts).pipe(
				Layer.provideMerge(HttpHost.layer),
			),
			{ disableLogger: true, disableListenLog: true },
		).pipe(
			Layer.provide(records.layer),
			Layer.provideMerge(NodeHttpServer.layerTest),
			Layer.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
		)
		const scope = yield* Scope.make()
		const services = yield* Layer.buildWithScope(app, scope)
		const answer = yield* Effect.provideContext(get("/raw"), services)
		assert.strictEqual(answer.status, 200)
		yield* close(scope)
		assert.deepStrictEqual(yield* Ref.get(late), Option.some(false))
	}),
)
