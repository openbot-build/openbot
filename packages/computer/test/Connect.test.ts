// The tests give each program its services at the edge.
// @effect-diagnostics strictEffectProvide:off
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { NodeSocket } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber } from "effect"
import { type WebSocket, WebSocketServer } from "ws"
import * as Connect from "../src/Connect.ts"

/**
 * A fake OpenBot that takes connector WebSockets and keeps their messages.
 * It stops when the test's scope closes.
 */
const fakeOpenBot = (options: { readonly token: string }) =>
	Effect.acquireRelease(
		Effect.promise(async () => {
			const server = new WebSocketServer({
				port: 0,
				host: "127.0.0.1",
				path: "/v1/hooks/computers/connect",
				verifyClient: (info, done) =>
					info.req.headers.authorization === `Bearer ${options.token}`
						? done(true)
						: done(false, 401),
			})
			await new Promise<void>((resolve) => server.once("listening", resolve))
			const { port } = server.address() as AddressInfo
			/** Waits for the next connection, and gives a way to read its messages in order. */
			const nextConnection = () =>
				new Promise<{
					readonly socket: WebSocket
					readonly next: () => Promise<any>
				}>((resolve) =>
					server.once("connection", (socket) => {
						const messages: Array<any> = []
						const waiting: Array<(message: any) => void> = []
						socket.on("message", (data) => {
							const message = JSON.parse(String(data))
							const waiter = waiting.shift()
							if (waiter === undefined) messages.push(message)
							else waiter(message)
						})
						resolve({
							socket,
							next: () =>
								messages.length > 0
									? Promise.resolve(messages.shift())
									: new Promise((resolve) => waiting.push(resolve)),
						})
					}),
				)
			return { server, url: `http://127.0.0.1:${port}`, nextConnection }
		}),
		({ server }) =>
			Effect.promise(
				() => new Promise<void>((resolve) => server.close(() => resolve())),
			),
	)

const start = (url: string, token: string) =>
	Effect.forkScoped(
		Connect.connect({
			config: { url, token, machineId: "machine-0123456789" },
			calls: { maxOutput: 1024 * 1024, home: tmpdir() },
			backoff: { firstMs: 10, maxMs: 50 },
		}).pipe(Effect.provide(NodeSocket.layerWebSocketConstructorWS)),
	)

it("the WebSocket address comes from the OpenBot address", () => {
	assert.strictEqual(
		Connect.socketUrl("https://openbot.example.com"),
		"wss://openbot.example.com/v1/hooks/computers/connect",
	)
	assert.strictEqual(
		Connect.socketUrl("http://127.0.0.1:3000"),
		"ws://127.0.0.1:3000/v1/hooks/computers/connect",
	)
})

it.live(
	"connect says Hello, answers Ping, does calls, and connects again",
	() =>
		Effect.gen(function* () {
			const openbot = yield* fakeOpenBot({ token: "good-token" })
			const first = openbot.nextConnection()
			yield* start(openbot.url, "good-token")
			const connection = yield* Effect.promise(() => first)
			assert.deepStrictEqual(yield* Effect.promise(connection.next), {
				_tag: "Hello",
				hello: {
					version: "0.1.0",
					os: process.platform,
					arch: process.arch,
					desktop: false,
				},
			})

			connection.socket.send(JSON.stringify({ _tag: "Ping" }))
			assert.deepStrictEqual(yield* Effect.promise(connection.next), {
				_tag: "Pong",
			})

			connection.socket.send(
				JSON.stringify({
					_tag: "Call",
					call: {
						id: "call-7",
						operation: {
							_tag: "Run",
							request: { command: "echo hi; sh -c 'exit 2'" },
						},
					},
				}),
			)
			const reply = yield* Effect.promise(connection.next)
			assert.strictEqual(reply._tag, "Reply")
			assert.strictEqual(reply.reply.id, "call-7")
			assert.strictEqual(reply.reply.result._tag, "Done")
			assert.strictEqual(reply.reply.result.value.exitCode, 2)
			assert.strictEqual(reply.reply.result.value.stdout, "hi\n")

			// When OpenBot drops the connection, the connector comes back and says Hello again.
			const second = openbot.nextConnection()
			connection.socket.terminate()
			const again = yield* Effect.promise(() => second)
			assert.strictEqual((yield* Effect.promise(again.next))._tag, "Hello")
		}),
)

it.live(
	"connect stops with a clear message when OpenBot refuses the token",
	() =>
		Effect.gen(function* () {
			const openbot = yield* fakeOpenBot({ token: "good-token" })
			const exit = yield* Fiber.await(yield* start(openbot.url, "bad-token"))
			assert.ok(Exit.isFailure(exit))
			assert.match(Cause.pretty(exit.cause), /OpenBot refused the token/)
		}),
)
