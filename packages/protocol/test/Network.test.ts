import assert from "node:assert/strict"
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
import { test } from "node:test"
import { ManagedRuntime, Effect, Exit, Fiber, Layer, Match } from "effect"
import { TestClock } from "effect/testing"
import * as Node from "@openbot-build/protocol/Node"
import { gzipSync } from "node:zlib"
import { startHttps } from "./Fixture.ts"

// These tests are runtime entry points and build their own Layers.

test("Public adapter blocks IP literals and the DNS address used by the socket", async () => {
	let requests = 0
	let connections = 0
	let lookups = 0
	const fixture = await startHttps((_req, res) => {
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
	try {
		await using runtime1 = ManagedRuntime.make(
			layerPublic.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
		)
		await assert.rejects(
			runtime1.runPromise(
				Network.Network.use((net) =>
					net.readDocument({
						url: fixture.ipOrigin,
					}),
				),
			),
			(error: unknown) =>
				error instanceof Network.NetworkError &&
				error.reason === "BlockedTarget",
		)
		await using runtime2 = ManagedRuntime.make(
			layerPublic.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
		)
		await assert.rejects(
			runtime2.runPromise(
				Network.Network.use((net) =>
					net.readDocument({
						url: `https://public.example:${new URL(fixture.origin).port}/`,
					}),
				),
			),
			/NetworkError/,
		)
		assert.equal(lookups, 1)
		assert.equal(requests, 0)
		assert.equal(connections, 0)
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
			assert.equal(NodeHttpServer.isPublicAddress(ip), false, ip)
		assert.equal(NodeHttpServer.isPublicAddress("8.8.8.8"), true)
		assert.equal(NodeHttpServer.isPublicAddress("2606:4700:4700::1111"), true)
	} finally {
		await fixture.close()
	}
})

test("Public adapter reaches a private address only when the address rule allows it", async () => {
	let requests = 0
	const fixture = await startHttps((_req, res) => {
		requests++
		res.end("listed")
	})
	try {
		await using runtime = ManagedRuntime.make(
			NodeHttpServer.layerPublicNetwork({
				ca: fixture.ca,
				allowAddress: (address, hostname) =>
					NodeHttpServer.isPublicAddress(address) || hostname === "localhost",
				lookup: (_host, _options, callback) =>
					callback(null, [{ address: "127.0.0.1", family: 4 }]),
			}).pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
		)
		const port = new URL(fixture.origin).port
		await assert.rejects(
			runtime.runPromise(
				Network.Network.use((net) =>
					net.readDocument({ url: `https://other.test:${port}/` }),
				),
			),
			/NetworkError/,
		)
		assert.equal(requests, 0)
		const reply = await runtime.runPromise(
			Network.Network.use((net) => net.readDocument({ url: fixture.origin })),
		)
		assert.equal(reply.text, "listed")
		assert.equal(requests, 1)
	} finally {
		await fixture.close()
	}
})

test("anonymous indexing and a user connection keep separate socket guards in one host", async () => {
	let requests = 0
	let publicLookups = 0
	const fixture = await startHttps((_req, res) => {
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
	try {
		await using runtime3 = ManagedRuntime.make(
			Layer.merge(user, indexing).pipe(
				Layer.provideMerge([CatalogDiscovery.layerRules]),
			),
		)
		await runtime3.runPromise(
			Effect.gen(function* () {
				const privateNetwork = yield* Network.Network
				assert.equal(privateNetwork.identity.scope, "user")
				yield* privateNetwork.readDocument({
					url: fixture.origin + "/private",
				})
				assert.equal(requests, 1)
				const result = yield* Indexing.sync({
					cardUrl: fixture.origin + "/card",
				})
				assert.equal(result._tag, "Unconfirmed")
				Match.value(result).pipe(
					Match.tag("Unconfirmed", (result) => {
						assert.equal(result.reason, "BlockedTarget")
					}),
					Match.orElse(() => undefined),
				)
				assert.equal(publicLookups, 1)
				assert.equal(requests, 1)
				// The public rejection does not change the user capability either.
				yield* privateNetwork.readDocument({
					url: fixture.origin + "/private",
				})
				assert.equal(requests, 2)
			}),
		)
	} finally {
		await fixture.close()
	}
})

test("User adapter checks every socket and redirect, removes cross-origin private headers and limits decoded bytes", async () => {
	let requests = 0
	let targetHeaders: import("node:http").IncomingHttpHeaders = {}
	const fixture = await startHttps((req, res) => {
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
	try {
		await using runtime4 = ManagedRuntime.make(
			user().pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
		)
		const reply = await runtime4.runPromise(
			Network.Network.use((net) =>
				net.readDocument({
					url: fixture.origin + "/redirect",
					headers: {
						authorization: "Bearer private",
						cookie: "owner=alice",
						"x-api-key": "private",
					},
				}),
			),
		)
		assert.equal(reply.text, "target")
		assert.equal(reply.url, fixture.ipOrigin + "/target")
		assert.equal(targetHeaders.authorization, undefined)
		assert.equal(targetHeaders.cookie, undefined)
		assert.equal(targetHeaders["x-api-key"], undefined)
		await using runtime5 = ManagedRuntime.make(
			user().pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
		)
		await assert.rejects(
			runtime5.runPromise(
				Network.Network.use((net) =>
					net.readDocument({
						url: fixture.origin + "/large",
					}),
				),
			),
			(error: unknown) =>
				error instanceof Network.NetworkError && error.reason === "TooLarge",
		)
		const beforeForbidden = requests
		await using runtime6 = ManagedRuntime.make(
			user().pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
		)
		await assert.rejects(
			runtime6.runPromise(
				Network.Network.use((net) =>
					net.readDocument({
						url: fixture.origin + "/forbidden",
					}),
				),
			),
			(error: unknown) =>
				error instanceof Network.NetworkError &&
				error.reason === "BlockedTarget",
		)
		assert.equal(requests, beforeForbidden + 1)
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
		await using runtime = ManagedRuntime.make(
			rebinding.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
		)
		const result = await runtime.runPromise(program)
		assert.ok(Exit.isFailure(result))
		assert.equal(lookups, 2)
	} finally {
		await fixture.close()
	}
})

test("Cancellation closes the response socket, and a document timeout is a typed failure", async () => {
	let started!: () => void
	let closed!: () => void
	const waiting = new Promise<void>((resolve) => (started = resolve))
	const released = new Promise<void>((resolve) => (closed = resolve))
	const fixture = await startHttps((_req, res) => {
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
	try {
		await using runtime7 = ManagedRuntime.make(
			layer.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
		)
		const fiber = runtime7.runFork(
			Network.Network.use((net) => net.readDocument({ url: fixture.ipOrigin })),
		)
		await waiting
		await Effect.runPromise(Fiber.interrupt(fiber))
		await released
		const timeoutStarted = new Promise<void>((resolve) => (started = resolve))
		const timed = NodeHttpServer.layerUserNetwork({
			owner: "alice",
			allowedOrigins: [fixture.ipOrigin],
			allowAddress: () => true,
			ca: fixture.ca,
			timeoutMs: 20,
		})
		await using runtime8 = ManagedRuntime.make(
			Layer.merge(timed, TestClock.layer()).pipe(
				Layer.provideMerge([CatalogDiscovery.layerRules]),
			),
		)
		await assert.rejects(
			runtime8.runPromise(
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
				}),
			),
			(error: unknown) =>
				error instanceof Network.NetworkError && error.reason === "Timeout",
		)
		assert.ok(Layer.isLayer(layer))
	} finally {
		await fixture.close()
	}
})
