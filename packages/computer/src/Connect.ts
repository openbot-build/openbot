import { ComputersApi } from "@openbot-build/api"
import { Effect, FiberSet, type FileSystem, Ref, Schema } from "effect"
import { Socket } from "effect/socket"
import * as Calls from "./Calls.ts"
import * as Config from "./Config.ts"
import * as Machine from "./Machine.ts"
import * as Sessions from "./Sessions.ts"

const decodeMessage = Schema.decodeUnknownEffect(
	Schema.fromJsonString(ComputersApi.ToConnector),
)
const encodeMessage = Schema.encodeEffect(
	Schema.fromJsonString(ComputersApi.FromConnector),
)

/** The WebSocket address for an OpenBot origin: `https` becomes `wss`, and `http` becomes `ws`. */
export const socketUrl = (origin: string): string => {
	const url = new URL("/v1/hooks/computers/connect", origin)
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
	return url.toString()
}

/**
 * True when OpenBot refused the token. The `ws` package then fails the open with the
 * error "Unexpected server response: 401", and Effect keeps that error as the cause.
 */
const isDenied = (error: Socket.SocketError): boolean => {
	if (error.reason._tag !== "SocketOpenError") return false
	const cause: unknown = error.reason.cause
	const message =
		typeof cause === "object" && cause !== null
			? "error" in cause && cause.error instanceof Error
				? cause.error.message
				: "message" in cause
					? String(cause.message)
					: ""
			: String(cause)
	return /\b401\b/.test(message)
}

export interface Backoff {
	/** The wait after the first lost connection. It doubles after each failed try. */
	readonly firstMs: number
	readonly maxMs: number
}

export const defaultBackoff: Backoff = { firstMs: 1000, maxMs: 60_000 }

export interface Events {
	readonly connected: Effect.Effect<void>
	readonly disconnected: (
		reason: string,
		retryInMs: number,
	) => Effect.Effect<void>
}

const silent: Events = {
	connected: Effect.void,
	disconnected: () => Effect.void,
}

/**
 * Keeps this machine connected to OpenBot and does the calls that OpenBot sends.
 * It connects again after each lost connection. It stops only when OpenBot refuses the token.
 */
export const connect = (options: {
	readonly config: Config.ComputerConfig
	readonly calls?: Calls.Options
	readonly backoff?: Backoff
	readonly events?: Events
}): Effect.Effect<
	never,
	Config.ComputerError,
	Socket.WebSocketConstructor | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const calls = options.calls ?? Calls.defaultOptions()
		const backoff = options.backoff ?? defaultBackoff
		const events = options.events ?? silent
		const failures = yield* Ref.make(0)
		const url = socketUrl(options.config.url)

		const session = Effect.gen(function* () {
			const socket = yield* Socket.makeWebSocket(url, {
				headers: { authorization: `Bearer ${options.config.token}` },
			})
			const reader = yield* socket.reader
			const writer = yield* socket.writer
			// The connector makes each message itself from the same schema, so a message
			// that cannot be encoded is a bug here, not a failure of the connection.
			const send = (message: ComputersApi.FromConnector) =>
				encodeMessage(message).pipe(Effect.orDie, Effect.flatMap(writer.write))
			yield* send({ _tag: "Hello", hello: Machine.hello() })
			yield* Ref.set(failures, 0)
			yield* events.connected
			const running = yield* FiberSet.make<void, Socket.SocketError>()
			// The sessions belong to the scope of this connection, so they stop when it closes.
			const sessions = yield* Sessions.make(
				{ home: calls.home, maxFrame: Sessions.defaultFrame },
				send,
			)
			const text = new TextDecoder()
			while (true) {
				const frames = yield* reader.pull
				for (const frame of frames) {
					const decoded = yield* decodeMessage(
						typeof frame === "string" ? frame : text.decode(frame),
					).pipe(Effect.option)
					if (decoded._tag === "None") {
						yield* Effect.logWarning(
							"OpenBot sent a message that this connector does not know.",
						)
						continue
					}
					const message = decoded.value
					if (message._tag === "Ping") yield* send({ _tag: "Pong" })
					else if (message._tag === "Call")
						yield* FiberSet.run(
							running,
							Calls.execute(message.call, calls).pipe(
								Effect.flatMap((reply) => send({ _tag: "Reply", reply })),
							),
						)
					else yield* sessions.handle(message)
				}
			}
		}).pipe(Effect.scoped)

		// This loop is not `Effect.retry`, because the count of failures goes back to zero
		// after each good connection, and the person sees each wait before it starts.
		while (true) {
			const error = yield* Effect.flip(session)
			if (isDenied(error))
				return yield* Config.ComputerError.make({
					message:
						"OpenBot refused the token of this machine. Run 'openbot computer pair' to pair it again.",
				})
			const count = yield* Ref.getAndUpdate(failures, (n) => n + 1)
			const waitMs = Math.min(backoff.firstMs * 2 ** count, backoff.maxMs)
			yield* events.disconnected(error.message, waitMs)
			yield* Effect.sleep(waitMs)
		}
	})
