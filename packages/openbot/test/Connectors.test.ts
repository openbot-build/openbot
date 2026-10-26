import { NodeSocket } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { ComputersApi } from "@openbot-build/api"
import {
	Deferred,
	Effect,
	Layer,
	Schedule,
	Schema,
	String as Str,
} from "effect"
import { Base64 } from "effect/encoding"
import { Socket } from "effect/socket"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"

const publicOrigin = "https://connectors.example.com"

const encodeMessage = Schema.encodeEffect(
	Schema.fromJsonString(ComputersApi.FromConnector),
)
const decodeMessage = Schema.decodeEffect(
	Schema.fromJsonString(ComputersApi.ToConnector),
)

/** The Computer did not get to a state in time. */
class TimedOut extends Schema.TaggedError<
	TimedOut,
	{ readonly brand: unique symbol }
>()("TimedOut", { state: Schema.String }) {
	override get message() {
		return "Timed out waiting for the state " + this.state
	}
}

it.layer(
	Layer.merge(
		BrowserHost.layerPlatform,
		NodeSocket.layerWebSocketConstructorWS,
	),
	{ excludeTestServices: true },
)((it) => {
	it.effect(
		"a new connection of a machine takes the place of the old one, and the Computer stays online",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({ publicOrigin })
				const alice = yield* host.login("connector-alice")
				const address = yield* host.address
				const send = Caller.withCookie({ address, publicOrigin })
				const computer = yield* send(alice.session, "/v1/computers", "POST", {
					name: "Build server",
					source: { _tag: "Connector" },
				}).pipe(Effect.flatMap(Caller.json(ComputersApi.Computer)))
				const path = "/v1/computers/" + computer.id
				const { token } = yield* send(
					alice.session,
					path + "/connector-token",
					"PUT",
				).pipe(Effect.flatMap(Caller.json(ComputersApi.ConnectorToken)))
				const state = send(alice.session, path).pipe(
					Effect.flatMap(Caller.json(ComputersApi.Computer)),
					Effect.map((current) => current.state),
				)
				const waitFor = (expected: ComputersApi.ComputerState) =>
					state.pipe(
						Effect.repeat({
							until: (current) => current === expected,
							schedule: Schedule.spaced("25 millis"),
							times: 399,
						}),
						Effect.flatMap((current) =>
							current === expected
								? Effect.void
								: Effect.fail(TimedOut.make({ state: expected })),
						),
					)

				const url =
					Str.replace(/^http/, "ws")(address) + "/v1/hooks/computers/connect"
				/** Connects as the machine. It answers each command with its name. */
				const connect = (name: string, desktop: boolean) =>
					Effect.gen(function* () {
						const socket = yield* Socket.makeWebSocket(url, {
							headers: { authorization: "Bearer " + token },
						})
						const frames = yield* Socket.readerString(socket)
						const writer = yield* socket.writer
						const reply = (message: ComputersApi.FromConnector) =>
							Effect.flatMap(encodeMessage(message), writer.write)
						const answer = Effect.fn("Connectors.answer")(function* (
							frame: string,
						) {
							const message = yield* decodeMessage(frame)
							if (message._tag !== "Start") return
							yield* reply({
								_tag: "Output",
								session: message.session,
								seq: 0,
								data: Base64.encode(name),
							})
							yield* reply({
								_tag: "Exit",
								session: message.session,
								code: 0,
								signal: null,
							})
						})
						/** The close code that OpenBot sent. */
						const closed = yield* Deferred.make<number>()
						yield* Effect.forkScoped(
							Effect.forever(
								Effect.flatMap(frames, (batch) =>
									Effect.forEach(batch, answer, { discard: true }),
								),
							).pipe(
								Effect.catchReason(
									"SocketError",
									"SocketCloseError",
									(reason) => Deferred.succeed(closed, reason.code),
								),
							),
						)
						yield* reply({
							_tag: "Hello",
							hello: {
								version: ComputersApi.connectorProtocolVersion,
								os: "linux",
								arch: "x64",
								desktop,
							},
						})
						return { closed: Deferred.await(closed) }
					})

				yield* Effect.gen(function* () {
					const first = yield* connect("first", false)
					yield* waitFor("running")
					// The same machine connects again while its old socket is still open.
					yield* connect("second", true)
					assert.strictEqual(yield* first.closed, 1000)
					const ran = yield* send(alice.session, path + "/sessions", "POST", {
						command: "uname",
					}).pipe(Effect.flatMap(Caller.json(ComputersApi.SessionOutput)))
					assert.strictEqual(ran.output, "second")
					assert.strictEqual(yield* state, "running")
					// The new connection has a desktop, but a paired machine gives no desktop stream.
					const stream = yield* send(
						alice.session,
						path + "/desktop/stream",
						"POST",
					)
					assert.strictEqual(stream.status, 409)
					assert.deepStrictEqual(yield* stream.json, {
						_tag: "ComputerUnsupported",
						feature: "stream",
					})
				}).pipe(Effect.scoped)
				// The new connection closed with its scope, so the machine is offline.
				yield* waitFor("offline")
			}),
		{ timeout: 120000 },
	)
})
