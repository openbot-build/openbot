// The tests give each program its services at the edge.
// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { NodeSocket } from "@effect/platform-node"
import { Cause, Effect, Exit, Fiber } from "effect"
import { type WebSocket, WebSocketServer } from "ws"
import * as Connect from "../src/Connect.ts"

/** A fake OpenBot that takes connector WebSockets and keeps their messages. */
const fakeOpenBot = async (options: { readonly token: string }) => {
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
	return {
		url: `http://127.0.0.1:${port}`,
		nextConnection,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	}
}

const start = (url: string, token: string) =>
	Effect.runFork(
		Connect.connect({
			config: { url, token, machineId: "machine-0123456789" },
			calls: { maxOutput: 1024 * 1024, home: tmpdir() },
			backoff: { firstMs: 10, maxMs: 50 },
		}).pipe(Effect.provide(NodeSocket.layerWebSocketConstructorWS)),
	)

test("the WebSocket address comes from the OpenBot address", () => {
	assert.equal(
		Connect.socketUrl("https://openbot.example.com"),
		"wss://openbot.example.com/v1/hooks/computers/connect",
	)
	assert.equal(
		Connect.socketUrl("http://127.0.0.1:3000"),
		"ws://127.0.0.1:3000/v1/hooks/computers/connect",
	)
})

test("connect says Hello, answers Ping, does calls, and connects again", async () => {
	const openbot = await fakeOpenBot({ token: "good-token" })
	const first = openbot.nextConnection()
	const fiber = start(openbot.url, "good-token")
	try {
		const connection = await first
		assert.deepEqual(await connection.next(), {
			_tag: "Hello",
			hello: {
				version: "0.1.0",
				os: process.platform,
				arch: process.arch,
				desktop: false,
			},
		})

		connection.socket.send(JSON.stringify({ _tag: "Ping" }))
		assert.deepEqual(await connection.next(), { _tag: "Pong" })

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
		const reply = await connection.next()
		assert.equal(reply._tag, "Reply")
		assert.equal(reply.reply.id, "call-7")
		assert.equal(reply.reply.result._tag, "Done")
		assert.equal(reply.reply.result.value.exitCode, 2)
		assert.equal(reply.reply.result.value.stdout, "hi\n")

		// When OpenBot drops the connection, the connector comes back and says Hello again.
		const second = openbot.nextConnection()
		connection.socket.terminate()
		const again = await second
		assert.equal((await again.next())._tag, "Hello")
	} finally {
		await Effect.runPromise(Fiber.interrupt(fiber))
		await openbot.close()
	}
})

test("connect stops with a clear message when OpenBot refuses the token", async () => {
	const openbot = await fakeOpenBot({ token: "good-token" })
	try {
		const exit = await Effect.runPromise(
			Fiber.await(start(openbot.url, "bad-token")),
		)
		assert.ok(Exit.isFailure(exit))
		assert.match(Cause.pretty(exit.cause), /OpenBot refused the token/)
	} finally {
		await openbot.close()
	}
})
