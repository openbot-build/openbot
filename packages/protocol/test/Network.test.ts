// Tests are entry points, so they provide their own Layers.
// @effect-diagnostics strictEffectProvide:off
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
import { Effect, Exit, Fiber, Layer, Match } from "effect"
import { TestClock } from "effect/testing"
import * as Node from "@openbot-build/protocol/Node"
import { gzipSync } from "node:zlib"
import { startHttps } from "./Fixture.ts"

// These tests build their own Layers. They use it.live, because they talk to
// a real HTTPS server.

// The server stops when the test ends.
const serve = (handler: Parameters<typeof startHttps>[0]) =>
	Effect.acquireRelease(
		Effect.promise(() => startHttps(handler)),
		(fixture) => Effect.promise(() => fixture.close()),
	)

it.live(
	"Public adapter blocks IP literals and the DNS address used by the socket",
	() =>
		Effect.gen(function* () {
			let requests = 0
			let connections = 0
			let lookups = 0
			const fixture = yield* serve((_req, res) => {
				requests++
				res.end("unreachable")
			})
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
				literal instanceof Network.NetworkError &&
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
			assert.match(String(named), /NetworkError/)
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
		}),
)

it.live(
	"Public adapter reaches a private address only when the address rule allows it",
	() =>
		Effect.gen(function* () {
			let requests = 0
			const fixture = yield* serve((_req, res) => {
				requests++
				res.end("listed")
			})
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
			assert.match(String(error), /NetworkError/)
			assert.strictEqual(requests, 0)
			const reply = yield* Network.Network.use((net) =>
				net.readDocument({ url: fixture.origin }),
			).pipe(Effect.provideContext(services))
			assert.strictEqual(reply.text, "listed")
			assert.strictEqual(requests, 1)
		}),
)

it.live(
	"anonymous indexing and a user connection keep separate socket guards in one host",
	() =>
		Effect.gen(function* () {
			let requests = 0
			let publicLookups = 0
			const fixture = yield* serve((_req, res) => {
				requests++
				res.writeHead(200, { "content-type": Document.cardMediaType })
				res.end("{}")
			})
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
				const result = yield* Indexing.sync({
					cardUrl: fixture.origin + "/card",
				})
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
		}),
)

it.live(
	"User adapter checks every socket and redirect, removes cross-origin private headers and limits decoded bytes",
	() =>
		Effect.gen(function* () {
			let requests = 0
			let targetHeaders: import("node:http").IncomingHttpHeaders = {}
			const fixture = yield* serve((req, res) => {
				requests++
				if (req.url === "/redirect") {
					res.writeHead(302, {
						location: fixture.ipOrigin + "/target",
					})
					res.end()
				} else if (req.url === "/target") {
					targetHeaders = req.headers
					res.end("target")
				} else if (req.url === "/large") {
					res.writeHead(200, { "content-encoding": "gzip" })
					res.end(gzipSync("a".repeat(2048)))
				} else if (req.url === "/forbidden") {
					res.writeHead(302, {
						location: "https://169.254.169.254/",
					})
					res.end()
				} else {
					res.end("ok")
				}
			})
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
			assert.strictEqual(targetHeaders.authorization, undefined)
			assert.strictEqual(targetHeaders.cookie, undefined)
			assert.strictEqual(targetHeaders["x-api-key"], undefined)
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
				large instanceof Network.NetworkError && large.reason === "TooLarge",
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
				forbidden instanceof Network.NetworkError &&
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
				return yield* Effect.exit(net.readDocument({ url: fixture.origin }))
			})
			const result = yield* program.pipe(
				Effect.provide(
					rebinding.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
				),
			)
			assert.ok(Exit.isFailure(result))
			assert.strictEqual(lookups, 2)
		}),
)

it.live(
	"Cancellation closes the response socket, and a document timeout is a typed failure",
	() =>
		Effect.gen(function* () {
			let started!: () => void
			let closed!: () => void
			const waiting = new Promise<void>((resolve) => (started = resolve))
			const released = new Promise<void>((resolve) => (closed = resolve))
			const fixture = yield* serve((_req, res) => {
				res.writeHead(200)
				res.write("partial")
				res.on("close", closed)
				started()
			})
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
			yield* Effect.promise(() => waiting)
			yield* Fiber.interrupt(fiber)
			yield* Effect.promise(() => released)
			const timeoutStarted = new Promise<void>((resolve) => (started = resolve))
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
					yield* Effect.promise(() => timeoutStarted)
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
				timeout instanceof Network.NetworkError && timeout.reason === "Timeout",
			)
			assert.ok(Layer.isLayer(layer))
		}),
)
