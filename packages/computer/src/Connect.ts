import { ComputersApi } from "@openbot-build/api"
import {
	Cause,
	Duration,
	Effect,
	FiberSet,
	type FileSystem,
	Option,
	type Path,
	Redacted,
	Ref,
	Schedule,
	Schema,
} from "effect"
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
 * Why the connection failed, such as "connect ECONNREFUSED 127.0.0.1:3000".
 * The message of a `SocketError` is only "An error occurred during Open", so this
 * takes the text of the error below it. The `ws` package gives an error event, and
 * the Node error is in its `error` field.
 */
const reasonText = (error: Socket.SocketError): string => {
	if (error.reason._tag === "SocketCloseError") return error.message
	const cause: unknown = error.reason.cause
	const inner =
		typeof cause === "object" && cause !== null && "error" in cause
			? cause.error
			: cause
	return Option.getOrElse(Config.errorText(inner), () => error.message)
}

/**
 * True when OpenBot refused the token. The `ws` package then fails the open with the
 * error "Unexpected server response: 401", and Effect keeps that error as the cause.
 */
const isDenied = (error: Socket.SocketError): boolean =>
	error.reason._tag === "SocketOpenError" &&
	/Unexpected server response: 401\b/.test(reasonText(error))

/** True when OpenBot closed the connection with code 4426, because this connector is too old. */
const isTooOld = (error: Socket.SocketError): boolean =>
	error.reason._tag === "SocketCloseError" && error.reason.code === 4426

/** OpenBot sends `Ping` every 20 seconds. So 60 seconds with no message means that the connection is dead. */
const silence = Duration.seconds(60)

/** The most bytes that the WebSocket may hold before session output waits. */
const sendHighWaterMark = 1024 * 1024

/** The bytes that the WebSocket holds and has not sent yet. The `ws` package and browsers both have `bufferedAmount`. */
const bufferedAmount = (ws: Socket.WebSocketLike): number =>
	"bufferedAmount" in ws && typeof ws.bufferedAmount === "number"
		? ws.bufferedAmount
		: 0

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
 * It connects again after each lost connection. It stops only when OpenBot refuses
 * the token, or when OpenBot needs a newer connector.
 */
export const connect = (options: {
	readonly config: Config.ComputerConfig
	readonly calls?: Calls.Options
	readonly backoff?: Backoff
	readonly events?: Events
}): Effect.Effect<
	never,
	Config.ComputerError,
	Socket.WebSocketConstructor | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const calls = options.calls ?? Calls.defaultOptions()
		const backoff = options.backoff ?? defaultBackoff
		const events = options.events ?? silent
		const failures = yield* Ref.make(0)
		const url = socketUrl(options.config.url)

		const session = Effect.gen(function* () {
			// The code keeps the WebSocket, so session output can wait for it.
			const current = yield* Ref.make(Option.none<Socket.WebSocketLike>())
			const socket = yield* Socket.WebSocketConstructor.use((makeWs) =>
				Socket.fromWebSocket(
					Effect.acquireRelease(
						Effect.sync(() =>
							makeWs(url, {
								headers: {
									authorization: `Bearer ${Redacted.value(options.config.token)}`,
								},
							}),
						).pipe(Effect.tap((ws) => Ref.set(current, Option.some(ws)))),
						(ws) => Effect.sync(() => ws.close(1000)),
					),
				),
			)
			const reader = yield* socket.reader
			const writer = yield* socket.writer
			// The connector makes each message itself from the same schema, so a message
			// that cannot be encoded is a bug here, not a failure of the connection.
			const send = (message: ComputersApi.FromConnector) =>
				encodeMessage(message).pipe(Effect.orDie, Effect.flatMap(writer.write))
			yield* send({ _tag: "Hello", hello: Machine.hello() })
			yield* events.connected
			const running = yield* FiberSet.make<void, Socket.SocketError>()
			// The socket writer gives each message to the WebSocket at once, and it does not
			// wait for the network. So session output waits here while the WebSocket holds
			// too much. Then the sessions pause their commands.
			const drained = Ref.get(current).pipe(
				Effect.map(
					Option.exists((ws) => bufferedAmount(ws) > sendHighWaterMark),
				),
				Effect.repeat({
					while: (full) => full,
					schedule: Schedule.spaced("10 millis"),
				}),
			)
			// The sessions belong to the scope of this connection, so they stop when it closes.
			const sessions = yield* Sessions.make(
				{
					home: calls.home,
					maxFrame: Sessions.defaultFrame,
					highWaterMark: Sessions.defaultHighWaterMark,
				},
				(message) => Effect.andThen(drained, send(message)),
			)
			const text = new TextDecoder()
			while (true) {
				const frames = yield* reader.pull.pipe(
					Effect.timeoutOrElse({
						duration: silence,
						orElse: () =>
							Effect.fail(
								Socket.SocketError.make({
									reason: Socket.SocketReadError.make({
										cause: new Error(
											`OpenBot sent nothing for ${Duration.toSeconds(silence)} seconds.`,
										),
									}),
								}),
							),
					}),
				)
				// OpenBot sends no answer to the Hello. A message from OpenBot shows that it
				// took the connection, so only then does the count of failures go back to zero.
				yield* Ref.set(failures, 0)
				for (const frame of frames) {
					const decoded = yield* decodeMessage(
						typeof frame === "string" ? frame : text.decode(frame),
					).pipe(
						Effect.tapError((error) =>
							Effect.logWarning(
								"OpenBot sent a message that this connector does not know.",
								Cause.fail(error),
							),
						),
						Effect.option,
					)
					if (Option.isNone(decoded)) continue
					const message = decoded.value
					if (message._tag === "Ping") yield* send({ _tag: "Pong" })
					else if (message._tag === "Call")
						yield* FiberSet.run(
							running,
							Calls.execute(message.call, calls).pipe(
								// A defect is a bug in the connector. OpenBot still gets a reply, so
								// it does not wait for its own time limit.
								Effect.catchDefect((defect) =>
									Effect.logError(
										"A call from OpenBot failed.",
										Cause.die(defect),
									).pipe(
										Effect.as<ComputersApi.ConnectorReply>({
											id: message.call.id,
											result: {
												_tag: "Failed",
												message:
													"The connector could not do the call. Its log has the details.",
											},
										}),
									),
								),
								Effect.flatMap((reply) => send({ _tag: "Reply", reply })),
								// Nobody joins this fiber, so a failure that is not logged here is lost.
								Effect.tapCause((cause) =>
									Cause.hasInterruptsOnly(cause)
										? Effect.void
										: Effect.logError(
												"Could not answer a call from OpenBot.",
												cause,
											),
								),
								Effect.annotateLogs({ call: message.call.id }),
							),
						)
					else yield* sessions.handle(message)
				}
			}
		}).pipe(Effect.scoped)

		// This loop is not `Effect.retry`, because the count of failures goes back to zero
		// when OpenBot first sends a message on a connection, and the person sees each wait
		// before it starts.
		while (true) {
			const error = yield* Effect.flip(session)
			if (isDenied(error))
				return yield* Config.ComputerError.make({
					message:
						"OpenBot refused the token of this machine. Run 'openbot computer pair' to pair it again.",
					cause: error,
				})
			// Another try cannot work, because the version of this connector does not change.
			if (isTooOld(error))
				return yield* Config.ComputerError.make({
					message:
						"OpenBot needs a newer openbot-computer. Update it, and then run 'openbot computer connect' again.",
					cause: error,
				})
			const count = yield* Ref.getAndUpdate(failures, (n) => n + 1)
			const waitMs = Math.min(backoff.firstMs * 2 ** count, backoff.maxMs)
			yield* Effect.logDebug(
				"The connection to OpenBot failed.",
				Cause.fail(error),
			)
			yield* events.disconnected(reasonText(error), waitMs)
			yield* Effect.sleep(waitMs)
		}
	})
