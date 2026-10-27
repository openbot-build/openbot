import {
	CatalogDiscovery,
	RobotsPolicy,
	PublicIndexing,
	MemoryIndex,
	Document,
	Indexing,
	Network,
} from "@openbot-build/protocol"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import {
	Effect,
	Fiber,
	Layer,
	Match,
	Queue,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { Headers, HttpServerRequest, HttpServerResponse } from "effect/http"
import { TestClock } from "effect/testing"
import * as Node from "@openbot-build/protocol/Node"
import { gzipSync } from "node:zlib"
import { type HttpsServer, serveHttps } from "./Fixture.ts"

// These tests build their own Layers. They use it.live, because they talk to
// a real HTTPS server. The server stops when the test ends.

it.live(
	"Public adapter blocks IP literals and the DNS address used by the socket",
	() =>
		Effect.gen(function* () {
			let requests = 0
			let connections = 0
			let lookups = 0
			const fixture = yield* serveHttps(
				Effect.sync(() => {
					requests++
					return HttpServerResponse.text("unreachable")
				}),
			)
			fixture.server.on("connection", () => connections++)
			const layerPublic = NodeHttpServer.layerPublicNetwork({
				ca: fixture.ca,
				lookup: (_host, _options, callback) => {
					lookups++
					callback(null, [{ address: "127.0.0.1", family: 4 }])
				},
			})
			const literal = yield* Effect.flip(
				Network.Network.use((net) =>
					net.readDocument({
						url: fixture.ipOrigin,
					}),
				).pipe(
					Effect.provide(
						layerPublic.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
					),
				),
			)
			assert.ok(
				Schema.is(Network.NetworkError)(literal) &&
					literal.reason === "BlockedTarget",
			)
			const named = yield* Effect.flip(
				Network.Network.use((net) =>
					net.readDocument({
						url: `https://public.example:${new URL(fixture.origin).port}/`,
					}),
				).pipe(
					Effect.provide(
						layerPublic.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
					),
				),
			)
			assert.ok(
				Schema.is(Network.NetworkError)(named) &&
					named.reason === "BlockedTarget",
			)
			assert.strictEqual(lookups, 1)
			assert.strictEqual(requests, 0)
			assert.strictEqual(connections, 0)
			for (const ip of [
				"127.1",
				"127.0.0.1",
				"169.254.169.254",
				"100.100.100.200",
				"::1",
				"::ffff:127.0.0.1",
				"fc00::1",
				"fe80::1",
				"192.88.99.1",
			])
				assert.strictEqual(NodeHttpServer.isPublicAddress(ip), false, ip)
			assert.strictEqual(NodeHttpServer.isPublicAddress("8.8.8.8"), true)
			assert.strictEqual(
				NodeHttpServer.isPublicAddress("2606:4700:4700::1111"),
				true,
			)
		}).pipe(Effect.provide(NodeServices.layer)),
)

it.live(
	"Public adapter reaches a private address only when the address rule allows it",
	() =>
		Effect.gen(function* () {
			let requests = 0
			const fixture = yield* serveHttps(
				Effect.sync(() => {
					requests++
					return HttpServerResponse.text("listed")
				}),
			)
			// One built Layer serves both calls, as one runtime did before.
			const services = yield* Layer.build(
				NodeHttpServer.layerPublicNetwork({
					ca: fixture.ca,
					allowAddress: (address, hostname) =>
						NodeHttpServer.isPublicAddress(address) || hostname === "localhost",
					lookup: (_host, _options, callback) =>
						callback(null, [{ address: "127.0.0.1", family: 4 }]),
				}).pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
			)
			const port = new URL(fixture.origin).port
			const error = yield* Effect.flip(
				Network.Network.use((net) =>
					net.readDocument({ url: `https://other.test:${port}/` }),
				).pipe(Effect.provideContext(services)),
			)
			assert.ok(
				Schema.is(Network.NetworkError)(error) &&
					error.reason === "BlockedTarget",
			)
			assert.strictEqual(requests, 0)
			const reply = yield* Network.Network.use((net) =>
				net.readDocument({ url: fixture.origin }),
			).pipe(Effect.provideContext(services))
			assert.strictEqual(reply.text, "listed")
			assert.strictEqual(requests, 1)
		}).pipe(Effect.provide(NodeServices.layer)),
)

it.live(
	"anonymous indexing and a user connection keep separate socket guards in one host",
	() =>
		Effect.gen(function* () {
			let requests = 0
			let publicLookups = 0
			const fixture = yield* serveHttps(
				Effect.sync(() => {
					requests++
					return HttpServerResponse.text("{}", {
						contentType: Document.cardMediaType,
					})
				}),
			)
			const user = NodeHttpServer.layerUserNetwork({
				owner: "alice",
				allowedOrigins: [fixture.origin],
				allowAddress: (ip) => ip === "127.0.0.1",
				ca: fixture.ca,
				lookup: (_host, _options, callback) =>
					callback(null, [{ address: "127.0.0.1", family: 4 }]),
			})
			const indexing = PublicIndexing.layer.pipe(
				Layer.provide(RobotsPolicy.layer),
				Layer.provide(
					Layer.mergeAll(
						MemoryIndex.layer,
						NodeHttpServer.layerPublicNetwork({
							ca: fixture.ca,
							lookup: (_host, _options, callback) => {
								publicLookups++
								callback(null, [
									{
										address: "127.0.0.1",
										family: 4,
									},
								])
							},
						}),
					),
				),
			)
			yield* Effect.gen(function* () {
				const privateNetwork = yield* Network.Network
				assert.strictEqual(privateNetwork.identity.scope, "user")
				yield* privateNetwork.readDocument({
					url: fixture.origin + "/private",
				})
				assert.strictEqual(requests, 1)
				const result = yield* Indexing.sync(
					Indexing.Input.make({ cardUrl: fixture.origin + "/card" }),
				)
				assert.strictEqual(result._tag, "Unconfirmed")
				Match.value(result).pipe(
					Match.tag("Unconfirmed", (result) => {
						assert.strictEqual(result.reason, "BlockedTarget")
					}),
					Match.orElse(() => undefined),
				)
				assert.strictEqual(publicLookups, 1)
				assert.strictEqual(requests, 1)
				// The public rejection does not change the user capability either.
				yield* privateNetwork.readDocument({
					url: fixture.origin + "/private",
				})
				assert.strictEqual(requests, 2)
			}).pipe(
				Effect.provide(
					Layer.merge(user, indexing).pipe(
						Layer.provideMerge([CatalogDiscovery.layerRules]),
					),
				),
			)
		}).pipe(Effect.provide(NodeServices.layer)),
)

it.live(
	"User adapter checks every socket and redirect, removes cross-origin private headers and limits decoded bytes",
	() =>
		Effect.gen(function* () {
			let requests = 0
			let targetHeaders = Headers.empty
			const fixture: HttpsServer = yield* serveHttps(
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest
					requests++
					if (request.url === "/redirect")
						return HttpServerResponse.redirect(fixture.ipOrigin + "/target")
					if (request.url === "/target") {
						targetHeaders = request.headers
						return HttpServerResponse.text("target")
					}
					if (request.url === "/large")
						return HttpServerResponse.uint8Array(
							gzipSync(Str.repeat(2048)("a")),
							{ headers: { "content-encoding": "gzip" } },
						)
					if (request.url === "/forbidden")
						return HttpServerResponse.redirect("https://169.254.169.254/")
					return HttpServerResponse.text("ok")
				}),
			)
			const user = (extra: Partial<Node.UserOptions> = {}) =>
				NodeHttpServer.layerUserNetwork({
					owner: "alice",
					allowedOrigins: [fixture.origin, fixture.ipOrigin],
					allowAddress: (ip) => ip === "127.0.0.1",
					ca: fixture.ca,
					maxBytes: 1024,
					lookup: (_host, _options, callback) =>
						callback(null, [{ address: "127.0.0.1", family: 4 }]),
					...extra,
				})
			const reply = yield* Network.Network.use((net) =>
				net.readDocument({
					url: fixture.origin + "/redirect",
					headers: {
						authorization: "Bearer private",
						cookie: "owner=alice",
						"x-api-key": "private",
					},
				}),
			).pipe(
				Effect.provide(
					user().pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
				),
			)
			assert.strictEqual(reply.text, "target")
			assert.strictEqual(reply.url, fixture.ipOrigin + "/target")
			assert.isFalse(Headers.has(targetHeaders, "authorization"))
			assert.isFalse(Headers.has(targetHeaders, "cookie"))
			assert.isFalse(Headers.has(targetHeaders, "x-api-key"))
			const large = yield* Effect.flip(
				Network.Network.use((net) =>
					net.readDocument({
						url: fixture.origin + "/large",
					}),
				).pipe(
					Effect.provide(
						user().pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
					),
				),
			)
			assert.ok(
				Schema.is(Network.NetworkError)(large) && large.reason === "TooLarge",
			)
			const beforeForbidden = requests
			const forbidden = yield* Effect.flip(
				Network.Network.use((net) =>
					net.readDocument({
						url: fixture.origin + "/forbidden",
					}),
				).pipe(
					Effect.provide(
						user().pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
					),
				),
			)
			assert.ok(
				Schema.is(Network.NetworkError)(forbidden) &&
					forbidden.reason === "BlockedTarget",
			)
			assert.strictEqual(requests, beforeForbidden + 1)
			let lookups = 0
			const rebinding = user({
				lookup: (_host, _options, callback) =>
					callback(null, [
						{
							address: ++lookups === 1 ? "127.0.0.1" : "127.0.0.2",
							family: 4,
						},
					]),
			})
			const program = Effect.gen(function* () {
				const net = yield* Network.Network
				yield* net.readDocument({ url: fixture.origin })
				return yield* Effect.flip(net.readDocument({ url: fixture.origin }))
			})
			const rebound = yield* program.pipe(
				Effect.provide(
					rebinding.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
				),
			)
			assert.ok(
				Schema.is(Network.NetworkError)(rebound) &&
					rebound.reason === "BlockedTarget",
			)
			assert.strictEqual(lookups, 2)
		}).pipe(Effect.provide(NodeServices.layer)),
)

it.live(
	"Cancellation closes the response socket, and a document timeout is a typed failure",
	() =>
		Effect.gen(function* () {
			// Each request sends a part of the body and then stays open. The
			// server tells the test when the part is sent and when the response
			// closes.
			const started = yield* Queue.unbounded<void>()
			const closed = yield* Queue.unbounded<void>()
			const fixture = yield* serveHttps(
				Effect.succeed(
					HttpServerResponse.stream(
						Stream.make("partial").pipe(
							Stream.encodeText,
							Stream.concat(
								Stream.fromEffectDrain(Queue.offer(started, undefined)),
							),
							Stream.concat(Stream.never),
							Stream.ensuring(Queue.offer(closed, undefined)),
						),
					),
				),
			)
			const layer = NodeHttpServer.layerUserNetwork({
				owner: "alice",
				allowedOrigins: [fixture.ipOrigin],
				allowAddress: (ip) => ip === "127.0.0.1",
				ca: fixture.ca,
			})
			const fiber = yield* Effect.forkChild(
				Network.Network.use((net) =>
					net.readDocument({ url: fixture.ipOrigin }),
				).pipe(
					Effect.provide(
						layer.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
					),
				),
			)
			yield* Queue.take(started)
			yield* Fiber.interrupt(fiber)
			yield* Queue.take(closed)
			const timed = NodeHttpServer.layerUserNetwork({
				owner: "alice",
				allowedOrigins: [fixture.ipOrigin],
				allowAddress: () => true,
				ca: fixture.ca,
				timeoutMs: 20,
			})
			// Only this part uses a TestClock, so the timeout passes at once.
			const timeout = yield* Effect.flip(
				Effect.gen(function* () {
					const request = yield* Effect.forkChild(
						Network.Network.use((net) =>
							net.readDocument({
								url: fixture.ipOrigin,
							}),
						),
					)
					yield* Queue.take(started)
					yield* TestClock.adjust("1 second")
					return yield* Fiber.join(request)
				}).pipe(
					Effect.provide(
						Layer.merge(timed, TestClock.layer()).pipe(
							Layer.provideMerge([CatalogDiscovery.layerRules]),
						),
					),
				),
			)
			assert.ok(
				Schema.is(Network.NetworkError)(timeout) &&
					timeout.reason === "Timeout",
			)
		}).pipe(Effect.provide(NodeServices.layer)),
)
