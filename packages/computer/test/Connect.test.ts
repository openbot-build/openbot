import {
	NodeServices,
	NodeSocket,
	NodeSocketServer,
} from "@effect/platform-node"
import { ComputersApi } from "@openbot-build/api"
import { assert, layer } from "@effect/vitest"
import {
	Deferred,
	Effect,
	Fiber,
	FileSystem,
	Layer,
	Queue,
	Redacted,
	Schema,
} from "effect"
import { Base64 } from "effect/encoding"
import { NetAddress } from "effect/net"
import type { Socket } from "effect/socket"
import * as Connect from "../src/Connect.ts"

const decodeMessage = Schema.decodeUnknownEffect(
	Schema.fromJsonString(ComputersApi.FromConnector),
)
const encodeMessage = Schema.encodeEffect(
	Schema.fromJsonString(ComputersApi.ToConnector),
)

/** One connection of the connector to the fake OpenBot. */
interface Connection {
	readonly send: (
		message: ComputersApi.ToConnector,
	) => Effect.Effect<void, Schema.SchemaError | Socket.SocketError>
	/** Takes the next message of the connector. The messages come in order. */
	readonly next: Effect.Effect<ComputersApi.FromConnector, Schema.SchemaError>
	/** Closes the connection from the side of OpenBot. */
	readonly drop: Effect.Effect<void>
}

/**
 * A fake OpenBot that takes connector WebSockets and keeps their messages.
 * It stops when the test's scope closes.
 */
const fakeOpenBot = Effect.fnUntraced(function* (options: {
	readonly token: string
}) {
	const server = yield* NodeSocketServer.makeWebSocket({
		port: 0,
		host: "127.0.0.1",
		path: "/v1/hooks/computers/connect",
		verifyClient: (info, done) =>
			info.req.headers.authorization === `Bearer ${options.token}`
				? done(true)
				: done(false, 401),
	})
	const connections = yield* Queue.unbounded<Connection>()
	yield* Effect.forkScoped(
		server.run((socket) =>
			Effect.gen(function* () {
				const reader = yield* socket.reader
				const writer = yield* socket.writer
				const frames = yield* Queue.unbounded<string | Uint8Array>()
				const dropped = yield* Deferred.make<void>()
				yield* Queue.offer(connections, {
					send: (message) =>
						Effect.flatMap(encodeMessage(message), writer.write),
					next: Effect.flatMap(Queue.take(frames), decodeMessage),
					drop: Effect.asVoid(Deferred.succeed(dropped, undefined)),
				})
				yield* reader.pull.pipe(
					Effect.flatMap((batch) => Queue.offerAll(frames, batch)),
					Effect.forever,
					// The connector closes the connection when the test ends.
					Effect.catchReason(
						"SocketError",
						"SocketCloseError",
						() => Effect.void,
					),
					Effect.raceFirst(Deferred.await(dropped)),
				)
			}).pipe(Effect.scoped),
		),
	)
	return {
		url: yield* Effect.fromResult(NetAddress.formatUrl(server.address)),
		/** Waits for the next connection of the connector. */
		nextConnection: Queue.take(connections),
	}
})

const start = Effect.fnUntraced(function* (
	url: string,
	token: string,
	events?: Connect.Events,
) {
	const fs = yield* FileSystem.FileSystem
	const home = yield* fs.makeTempDirectoryScoped({
		prefix: "openbot-computer-connect-",
	})
	return yield* Effect.forkScoped(
		Connect.connect({
			config: {
				url,
				token: Redacted.make(token),
				machineId: "machine-0123456789",
			},
			calls: { home },
			backoff: { firstMs: 10, maxMs: 50 },
			...(events === undefined ? {} : { events }),
		}),
	)
})

layer(Layer.merge(NodeSocket.layerWebSocketConstructorWS, NodeServices.layer), {
	excludeTestServices: true,
})((it) => {
	it.effect("the WebSocket address comes from the OpenBot address", () =>
		Effect.sync(() => {
			assert.strictEqual(
				Connect.socketUrl("https://openbot.example.com"),
				"wss://openbot.example.com/v1/hooks/computers/connect",
			)
			assert.strictEqual(
				Connect.socketUrl("http://127.0.0.1:3000"),
				"ws://127.0.0.1:3000/v1/hooks/computers/connect",
			)
		}),
	)

	it.effect(
		"connect says Hello, answers Ping, does calls and sessions, and connects again",
		() =>
			Effect.gen(function* () {
				const openbot = yield* fakeOpenBot({ token: "good-token" })
				yield* start(openbot.url, "good-token")
				const connection = yield* openbot.nextConnection
				assert.deepStrictEqual(yield* connection.next, {
					_tag: "Hello",
					hello: {
						version: 2,
						os: process.platform,
						arch: process.arch,
						desktop: false,
					},
				})

				yield* connection.send({ _tag: "Ping" })
				assert.deepStrictEqual(yield* connection.next, { _tag: "Pong" })

				yield* connection.send({
					_tag: "Call",
					call: { id: "call-7", operation: { _tag: "List", path: "." } },
				})
				const reply = yield* connection.next
				if (reply._tag !== "Reply")
					return assert.fail(`The connector sent ${reply._tag}, not Reply.`)
				assert.deepStrictEqual(reply.reply, {
					id: "call-7",
					result: { _tag: "Done", value: [] },
				})

				yield* connection.send({
					_tag: "Start",
					session: "s-1",
					command: "echo hi; sh -c 'exit 2'",
					tty: false,
				})
				assert.deepStrictEqual(yield* connection.next, {
					_tag: "Output",
					session: "s-1",
					seq: 0,
					data: Base64.encode("hi\n"),
				})
				assert.deepStrictEqual(yield* connection.next, {
					_tag: "Exit",
					session: "s-1",
					code: 2,
					signal: null,
				})

				// When OpenBot drops the connection, the connector comes back and says Hello again.
				yield* connection.drop
				const again = yield* openbot.nextConnection
				assert.strictEqual((yield* again.next)._tag, "Hello")
			}),
	)

	it.effect("connect says why the connection failed", () =>
		Effect.gen(function* () {
			const reasons = yield* Queue.unbounded<string>()
			// Nothing listens on port 1, so the machine refuses the connection.
			yield* start("http://127.0.0.1:1", "good-token", {
				connected: Effect.void,
				disconnected: (reason) => Effect.asVoid(Queue.offer(reasons, reason)),
			})
			assert.match(yield* Queue.take(reasons), /ECONNREFUSED/)
		}),
	)

	it.effect(
		"connect stops with a clear message when OpenBot refuses the token",
		() =>
			Effect.gen(function* () {
				const openbot = yield* fakeOpenBot({ token: "good-token" })
				const error = yield* Fiber.join(
					yield* start(openbot.url, "bad-token"),
				).pipe(Effect.flip)
				assert.strictEqual(error._tag, "ComputerError")
				assert.strictEqual(
					error.message,
					"OpenBot refused the token of this machine. Run 'openbot computer pair' to pair it again.",
				)
			}),
	)
})
