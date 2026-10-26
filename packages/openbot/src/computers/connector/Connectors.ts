import { ComputersApi } from "@openbot-build/api"
import { PgClient } from "@effect/sql-pg"
import { eq, lt } from "drizzle-orm"
import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	Crypto,
	Data,
	Deferred,
	Duration,
	Effect,
	HashMap,
	Layer,
	Option,
	PubSub,
	pipe,
	Ref,
	Result,
	Schedule,
	Schema,
	Scope,
	Stream,
	String as Str,
} from "effect"
import { Base64 } from "effect/encoding"
import { Socket } from "effect/socket"
import * as Background from "../../app/Background.ts"
import * as Failures from "../../app/Failures.ts"
import * as Db from "../../database/Database.ts"
import { computerCalls, computers } from "../../database/Schema.ts"
import {
	ComputerCallFailed,
	ComputerGone,
	type Exit,
	type Process,
	type StartRequest,
} from "../Computer.ts"
import * as ProcessSink from "../Process.ts"

/** Every instance listens on this channel for calls, replies and closes. */
export const channel = "openbot_computer_calls"

/**
 * The messages of command sessions between instances. The instance with the
 * connection passes messages to the machine, and sends its output back here.
 */
export const sessionChannel = "openbot_computer_sessions"

/**
 * The longest base64 text of one output message between instances. A Postgres notice
 * holds less than 8000 bytes. The length is a multiple of 4, so each part decodes alone.
 */
const partLength = 6000

/** A session message from one instance to another. */
const SessionNotice = Schema.Union([
	Schema.Struct({ to: Schema.String, message: ComputersApi.ToConnector }),
	Schema.Struct({
		from: Schema.String,
		/** The order of the messages of a session. Notices can come out of order. */
		order: Schema.Int,
		message: ComputersApi.FromConnector,
	}),
])
const encodeSessionNotice = Schema.encodeEffect(
	Schema.fromJsonString(SessionNotice),
)
const decodeSessionNotice = Schema.decodeUnknownEffect(
	Schema.fromJsonString(SessionNotice),
)

/** Where the output of a session goes on the instance with the connection. */
type Route = Data.TaggedEnum<{
	Here: { readonly sink: ProcessSink.Sink }
	Away: { readonly order: Ref.Ref<number> }
}>
const Route = Data.taggedEnum<Route>()

/** A session that this instance started on a connection of another instance. */
interface Owned {
	readonly computerId: string
	readonly sink: ProcessSink.Sink
	readonly reorder: Ref.Ref<Reorder>
}

/** The order of the next message, and the messages that came too early. */
interface Reorder {
	readonly next: number
	readonly early: HashMap.HashMap<number, ComputersApi.FromConnector>
	/**
	 * Since when the messages in `early` wait for an earlier message. It is none
	 * when no message waits. Each message that comes in order starts the time again.
	 */
	readonly gapSince: Option.Option<number>
}

/** Keeps a message, and takes the messages that are now in order. */
const reorder = (
	state: Reorder,
	order: number,
	message: ComputersApi.FromConnector,
	now: number,
): readonly [ReadonlyArray<ComputersApi.FromConnector>, Reorder] => {
	// A message before `next` came a second time, such as after a retry, so it is left out.
	if (order < state.next) return [[], state]
	const early = HashMap.set(state.early, order, message)
	const ready = Arr.unfold(state.next, (at) =>
		Option.map(HashMap.get(early, at), (found) => [found, at + 1] as const),
	)
	const waiting = Arr.reduce(ready, early, (map, _, index) =>
		HashMap.remove(map, state.next + index),
	)
	return [
		ready,
		{
			next: state.next + ready.length,
			early: waiting,
			gapSince: HashMap.isEmpty(waiting)
				? Option.none()
				: Arr.isArrayNonEmpty(ready) || Option.isNone(state.gapSince)
					? Option.some(now)
					: state.gapSince,
		},
	]
}

/** Gives the next order number of a session, and counts it. */
const nextOrder = (order: Ref.Ref<number>) =>
	Ref.getAndUpdate(order, (value) => value + 1)

const closedMessage = "The connection to the machine closed."
const closedExit: Exit = { code: null, signal: null, error: closedMessage }

/**
 * How long the output of a session on another instance may wait for a part
 * that does not come. After that, OpenBot takes the part as lost.
 */
const lostAfter = Duration.seconds(15)

/** The most parts of output that may wait for an earlier part that does not come. */
const mostWaiting = 1000

const lostExit: Exit = {
	code: null,
	signal: null,
	error: "Output from the machine was lost between instances.",
}

/** OpenBot pings each connector this often. Two missed pongs close the connection. */
export const pingEvery = Duration.seconds(20)

/** The longest wait for a reply when the call has no timeout of its own. */
const defaultWait = Duration.minutes(2)

// Every value that this file encodes passed its schema before, so a failure to encode is a defect.
const encodeTo = Schema.encodeEffect(
	Schema.fromJsonString(ComputersApi.ToConnector),
)
const decodeFrom = Schema.decodeUnknownEffect(
	Schema.fromJsonString(ComputersApi.FromConnector),
)
const encodeCall = Schema.encodeEffect(
	Schema.fromJsonString(ComputersApi.ConnectorCall),
)
const decodeCall = Schema.decodeUnknownEffect(
	Schema.fromJsonString(ComputersApi.ConnectorCall),
)
const encodeReply = Schema.encodeEffect(
	Schema.fromJsonString(ComputersApi.ConnectorReply),
)
const decodeReply = Schema.decodeUnknownEffect(
	Schema.fromJsonString(ComputersApi.ConnectorReply),
)

/** A write fails when the socket is closed. That does no harm, so only a debug log keeps it. */
const logWriteFailure = Effect.catch((error: Socket.SocketError) =>
	Effect.logDebug("OpenBot could not write to a connector", Cause.fail(error)),
)

type Operation = ComputersApi.ConnectorCall["operation"]
type Result = ComputersApi.ConnectorReply["result"]

/** A connection on this instance. */
interface Local {
	/** The ID of this connection, so a close notice can keep it. */
	readonly id: string
	readonly send: (message: ComputersApi.ToConnector) => Effect.Effect<void>
	/** Closes the connection, and the Computer goes offline. */
	readonly close: Effect.Effect<void>
	/** Closes the connection, because a new connection of the machine takes its place. */
	readonly replace: Effect.Effect<void>
	readonly waiting: Ref.Ref<HashMap.HashMap<string, Deferred.Deferred<Result>>>
	/** The command sessions on this connection. */
	readonly sessions: Ref.Ref<HashMap.HashMap<string, Route>>
}

/**
 * The connectors of the machines of people. A connector keeps one WebSocket open to
 * one instance. A call from any instance goes through the `computer_calls` table and a
 * Postgres notice, so the instance with the connection can pass it on.
 */
export class Connectors extends Context.Service<
	Connectors,
	{
		/**
		 * Serves one connector until its socket closes. `online` runs after its hello,
		 * and `offline` when it goes. A new connection of the same machine takes the
		 * place of the old one, and then only the new one changes the state.
		 */
		readonly serve: (input: {
			readonly computerId: string
			readonly socket: Socket.Socket
			readonly online: (
				hello: ComputersApi.ConnectorHello,
			) => Effect.Effect<void>
			readonly offline: Effect.Effect<void>
		}) => Effect.Effect<void>
		/** Sends a call to the connector of a Computer, on any instance, and waits for the reply. */
		readonly call: (
			computerId: string,
			operation: Operation,
			wait?: Duration.Duration,
		) => Effect.Effect<unknown, ComputerCallFailed | ComputerGone>
		/** Closes the connection of a Computer, on any instance. */
		readonly close: (computerId: string) => Effect.Effect<void>
		/** Starts a command session on the machine, through any instance. */
		readonly start: (
			computerId: string,
			request: StartRequest,
		) => Effect.Effect<Process, ComputerCallFailed | ComputerGone, Scope.Scope>
		/** Removes calls that nobody took, such as after an instance stopped. */
		readonly removeOld: (before: number) => Effect.Effect<void>
	}
>()("@openbot-build/openbot/computers/connector/Connectors") {}

const notice = (kind: "call" | "reply" | "close", id: string) => kind + ":" + id

/** Why OpenBot closes the connection of an old connector. */
export const oldConnector =
	"This openbot-computer is too old. Update it, and then connect again."

/**
 * A close notice names the Computer and the connection that stays, which may be none.
 * The instance that sends it also gets it, so it must not close its own new connection.
 */
const closeNotice = (computerId: string, keep: string) =>
	notice("close", computerId + "/" + keep)

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const client = yield* PgClient.PgClient
	const crypto = yield* Crypto.Crypto
	// OpenBot needs secure random numbers to run, so a failure here is a defect.
	const newUuid = crypto.randomUUIDv4().pipe(Effect.orDie)
	const scope = yield* Scope.Scope
	const locals = yield* Ref.make(HashMap.empty<string, Local>())
	const replies = yield* PubSub.unbounded<string>()
	yield* Effect.addFinalizer(() => PubSub.shutdown(replies))

	const notify = (payload: string) => client.notify(channel, payload)
	/**
	 * A lost session message stops the output of the session, so OpenBot tries
	 * again a few times.
	 */
	const notifySession = (value: typeof SessionNotice.Type) =>
		encodeSessionNotice(value).pipe(
			Effect.orDie,
			Effect.flatMap((payload) =>
				client.notify(sessionChannel, payload).pipe(
					Effect.retry({
						schedule: Schedule.exponential(Duration.millis(100)),
						times: 3,
					}),
					Background.logFailure(
						"OpenBot could not send a session message to another instance",
					),
				),
			),
		)
	const owned = yield* Ref.make(HashMap.empty<string, Owned>())

	/** Gives a message of the machine to the sink of its session. */
	const deliverTo = (
		sink: ProcessSink.Sink,
		message: ComputersApi.FromConnector,
	) =>
		message._tag === "Output"
			? Result.match(Base64.decode(message.data), {
					onFailure: (error) =>
						Effect.logDebug(
							"A connector output part is not base64",
							Cause.fail(error),
						),
					onSuccess: (bytes) => sink.push(bytes),
				})
			: message._tag === "Exit"
				? sink.end({
						code: message.code,
						signal: message.signal,
						...(message.error === undefined ? {} : { error: message.error }),
					})
				: Effect.void

	/** Passes output of the machine to the instance that started the session. */
	const forward = (
		session: string,
		order: Ref.Ref<number>,
		message: ComputersApi.FromConnector,
	) =>
		Effect.gen(function* () {
			if (message._tag !== "Output") {
				yield* notifySession({
					from: session,
					order: yield* nextOrder(order),
					message,
				})
				return
			}
			for (let at = 0; at < message.data.length; at += partLength)
				yield* notifySession({
					from: session,
					order: yield* nextOrder(order),
					message: {
						...message,
						data: pipe(message.data, Str.slice(at, at + partLength)),
					},
				})
		})

	/** A message of a session from another instance. */
	const onSessionNotice = (payload: string) =>
		Effect.gen(function* () {
			const parsed = yield* decodeSessionNotice(payload).pipe(
				Effect.tapError((error) =>
					Effect.logDebug(
						"A connector session notice does not decode",
						Cause.fail(error),
					),
				),
				Effect.option,
			)
			if (Option.isNone(parsed)) return
			const value = parsed.value
			if ("to" in value) {
				const found = yield* local(value.to)
				if (Option.isNone(found)) return
				const message = value.message
				if (message._tag === "Start") {
					const order = yield* Ref.make(0)
					yield* Ref.update(
						found.value.sessions,
						HashMap.set<string, Route>(message.session, Route.Away({ order })),
					)
				}
				yield* found.value.send(message)
				return
			}
			const target = HashMap.get(yield* Ref.get(owned), value.from)
			if (Option.isNone(target)) return
			const now = yield* Clock.currentTimeMillis
			const ready = yield* Ref.modify(target.value.reorder, (state) =>
				reorder(state, value.order, value.message, now),
			)
			for (const message of ready) {
				yield* deliverTo(target.value.sink, message)
				if (message._tag === "Exit")
					yield* Ref.update(owned, HashMap.remove(value.from))
			}
		})

	/** The notices of a channel. A new listen starts when the connection breaks. */
	const notices = (name: string) =>
		Stream.unwrap(
			Effect.map(client.listen(name), (queue) => Stream.fromQueue(queue)),
		)
	const listenAgain = Schedule.spaced(Duration.seconds(1))

	yield* Background.repeat(
		notices(sessionChannel).pipe(
			Stream.runForEach(({ payload }) => onSessionNotice(payload)),
		),
		{
			schedule: listenAgain,
			message: "The session listener stopped. It starts again.",
		},
	)

	/**
	 * Ends the sessions on other instances whose output waits too long for a
	 * part that does not come, such as a notice that Postgres lost.
	 */
	const endLost = Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis
		yield* Effect.forEach(
			yield* Ref.get(owned),
			([session, target]) =>
				Effect.gen(function* () {
					const state = yield* Ref.get(target.reorder)
					const lost =
						HashMap.size(state.early) > mostWaiting ||
						Option.exists(
							state.gapSince,
							(since) => now - since >= Duration.toMillis(lostAfter),
						)
					if (!lost) return
					yield* Ref.update(owned, HashMap.remove(session))
					yield* target.sink.end(lostExit)
					// The sink has ended, so the session does not send its close.
					// The machine must still stop the command.
					yield* notifySession({
						to: target.computerId,
						message: { _tag: "Close", session },
					})
				}),
			{ discard: true },
		)
	})
	yield* Background.repeat(endLost, {
		schedule: Schedule.spaced(Duration.seconds(5)),
		message: "OpenBot could not end the sessions with lost output",
	})

	const local = (computerId: string) =>
		Effect.map(Ref.get(locals), HashMap.get(computerId))

	/** Sends a call to a connection on this instance and waits for its result. */
	const callLocal = (
		connection: Local,
		call: ComputersApi.ConnectorCall,
		wait: Duration.Duration,
	) =>
		Effect.gen(function* () {
			const done = yield* Deferred.make<Result>()
			yield* Ref.update(connection.waiting, HashMap.set(call.id, done))
			yield* connection.send({ _tag: "Call", call })
			return yield* Deferred.await(done).pipe(
				Effect.timeoutOption(wait),
				Effect.ensuring(
					Ref.update(connection.waiting, HashMap.remove(call.id)),
				),
			)
		})

	/** Another instance asked for a call. Pass it on when the connection is here. */
	const onCall = (id: string) =>
		Effect.gen(function* () {
			const row = (yield* db
				.select()
				.from(computerCalls)
				.where(eq(computerCalls.id, id)))[0]
			if (row === undefined || row.reply !== null) return
			const found = yield* local(row.computerId)
			if (Option.isNone(found)) return
			const call = yield* decodeCall(row.call).pipe(
				Effect.tapError((error) =>
					Effect.logError("A stored connector call has a bad value", error),
				),
				Effect.option,
			)
			if (Option.isNone(call)) return
			const result = yield* callLocal(found.value, call.value, defaultWait)
			if (Option.isNone(result)) return
			const reply = yield* encodeReply({ id, result: result.value }).pipe(
				Effect.orDie,
			)
			yield* db
				.update(computerCalls)
				.set({ reply })
				.where(eq(computerCalls.id, id))
			yield* notify(notice("reply", id))
		})

	/** A call, reply or close notice from an instance. */
	const onNotice = (payload: string) =>
		Effect.gen(function* () {
			const colon = pipe(payload, Str.indexOf(":"))
			if (Option.isNone(colon)) return
			const kind = pipe(payload, Str.slice(0, colon.value))
			const id = pipe(payload, Str.slice(colon.value + 1))
			if (kind === "call")
				yield* Effect.forkIn(
					onCall(id).pipe(
						Background.logFailure(
							"A connector call of another instance failed",
						),
					),
					scope,
				)
			else if (kind === "reply") yield* PubSub.publish(replies, id)
			else if (kind === "close") {
				const [computerId = "", keep = ""] = Str.split(id, "/")
				const found = yield* local(computerId)
				// A notice that keeps a connection comes from a new connection of the machine.
				if (Option.isSome(found) && found.value.id !== keep)
					yield* keep === "" ? found.value.close : found.value.replace
			}
		})
	yield* Background.repeat(
		notices(channel).pipe(
			Stream.runForEach(({ payload }) => onNotice(payload)),
		),
		{
			schedule: listenAgain,
			message: "The connector listener stopped. It starts again.",
		},
	)

	/** Sends a call through the table to the instance with the connection. */
	const callRemote = (
		computerId: string,
		call: ComputersApi.ConnectorCall,
		wait: Duration.Duration,
	) =>
		Effect.scoped(
			Effect.gen(function* () {
				const subscription = yield* PubSub.subscribe(replies)
				const now = yield* Clock.currentTimeMillis
				yield* db
					.insert(computerCalls)
					.values({
						id: call.id,
						computerId,
						call: yield* encodeCall(call).pipe(Effect.orDie),
						createdAt: now,
					})
					.pipe(
						Failures.replace("OpenBot could not store a connector call", () =>
							ComputerCallFailed.make({
								message: "OpenBot could not store the call.",
								retry: true,
							}),
						),
					)
				// `removeOld` also removes the call later, so a failure here does no harm.
				yield* Effect.addFinalizer(() =>
					db
						.delete(computerCalls)
						.where(eq(computerCalls.id, call.id))
						.pipe(
							Background.logFailure(
								"OpenBot could not remove a connector call",
								{ level: "Debug" },
							),
						),
				)
				yield* notify(notice("call", call.id)).pipe(
					Failures.replace(
						"OpenBot could not send a connector call notice",
						() =>
							ComputerCallFailed.make({
								message: "OpenBot could not send the call.",
								retry: true,
							}),
					),
				)
				const replied = yield* Stream.fromSubscription(subscription).pipe(
					Stream.filter((id) => id === call.id),
					Stream.runHead,
					Effect.timeoutOption(wait),
				)
				if (Option.isNone(replied)) return Option.none<Result>()
				const row = (yield* db
					.select()
					.from(computerCalls)
					.where(eq(computerCalls.id, call.id))
					.pipe(
						Failures.replace("OpenBot could not read a connector reply", () =>
							ComputerCallFailed.make({
								message: "OpenBot could not read the reply.",
								retry: true,
							}),
						),
					))[0]
				if (row?.reply == null) return Option.none<Result>()
				const reply = yield* decodeReply(row.reply).pipe(
					Failures.replace("A stored connector reply has a bad value", () =>
						ComputerCallFailed.make({
							message: "OpenBot could not read the reply of the machine.",
							retry: false,
						}),
					),
				)
				return Option.some(reply.result)
			}),
		)

	const isConnected = (computerId: string) =>
		db
			.select({ state: computers.state })
			.from(computers)
			.where(eq(computers.id, computerId))
			.pipe(
				Effect.map((rows) => rows[0]?.state === "running"),
				Failures.replace(
					"OpenBot could not read the state of a connector Computer",
					() =>
						ComputerCallFailed.make({
							message: "OpenBot could not read the state of the machine.",
							retry: true,
						}),
				),
			)

	return Connectors.of({
		serve: ({ computerId, socket, online, offline }) =>
			Effect.gen(function* () {
				const id = yield* newUuid
				/** Completes when the connection must close: `true` when a new connection takes its place. */
				const closed = yield* Deferred.make<boolean>()
				yield* Effect.scoped(
					Effect.gen(function* () {
						// The reader does the handshake, and the writer waits for it, so the reader comes first.
						const reader = yield* socket.reader
						const writer = yield* socket.writer
						const send = (message: ComputersApi.ToConnector) =>
							encodeTo(message).pipe(
								Effect.orDie,
								Effect.flatMap((text) => writer.write(text)),
								logWriteFailure,
							)
						const waiting = yield* Ref.make(
							HashMap.empty<string, Deferred.Deferred<Result>>(),
						)
						const sessions = yield* Ref.make(HashMap.empty<string, Route>())
						const connection: Local = {
							id,
							send,
							close: Deferred.succeed(closed, false).pipe(Effect.asVoid),
							replace: Deferred.succeed(closed, true).pipe(Effect.asVoid),
							waiting,
							sessions,
						}
						// The machine stops its sessions when the connection closes.
						yield* Effect.addFinalizer(() =>
							Ref.get(sessions).pipe(
								Effect.flatMap((current) =>
									Effect.forEach(
										current,
										([session, route]) =>
											route._tag === "Here"
												? route.sink.end(closedExit)
												: nextOrder(route.order).pipe(
														Effect.flatMap((order) =>
															notifySession({
																from: session,
																order,
																message: {
																	_tag: "Exit",
																	session,
																	code: null,
																	signal: null,
																	error: closedMessage,
																},
															}),
														),
													),
										{ discard: true },
									),
								),
							),
						)
						const decoder = new TextDecoder()
						const next = reader.pull.pipe(
							Effect.map((frames) =>
								Arr.map(frames, (frame) =>
									typeof frame === "string" ? frame : decoder.decode(frame),
								),
							),
						)
						// The first message must be the hello of the machine.
						const first = (yield* next)[0]
						const hello = yield* decodeFrom(first)
						if (hello._tag !== "Hello") return
						// An old connector does not know command sessions, so it must update first.
						if (hello.hello.version < ComputersApi.connectorProtocolVersion) {
							yield* writer
								.write(new Socket.CloseEvent(4426, oldConnector))
								.pipe(logWriteFailure)
							return
						}
						// A new connection of the same Computer replaces the old one, here or on another instance.
						const previous = yield* Ref.modify(
							locals,
							(map) =>
								[
									HashMap.get(map, computerId),
									HashMap.set(map, computerId, connection),
								] as const,
						)
						if (Option.isSome(previous)) yield* previous.value.replace
						else
							yield* notify(closeNotice(computerId, id)).pipe(
								Background.logFailure(
									"OpenBot could not send a connector close notice",
								),
							)
						yield* online(hello.hello)
						/** The pings since the last pong. */
						const unanswered = yield* Ref.make(0)
						// Each ping waits its time first. Two pings without a pong end the heartbeat.
						const heartbeat = Ref.modify(unanswered, (count) =>
							count >= 2 ? [false, count] : [true, count + 1],
						).pipe(
							Effect.tap((alive) =>
								alive ? send({ _tag: "Ping" }) : Effect.void,
							),
							Effect.delay(pingEvery),
							Effect.repeat({ while: (alive) => alive }),
							Effect.asVoid,
						)
						/** Handles one message of the machine. */
						const onMessage = (message: ComputersApi.FromConnector) =>
							Effect.gen(function* () {
								if (message._tag === "Pong") yield* Ref.set(unanswered, 0)
								else if (message._tag === "Reply") {
									const reply = message.reply
									const done = HashMap.get(yield* Ref.get(waiting), reply.id)
									if (Option.isSome(done))
										yield* Deferred.succeed(done.value, reply.result)
								} else if (
									message._tag === "Output" ||
									message._tag === "Exit"
								) {
									const session = message.session
									const route = HashMap.get(yield* Ref.get(sessions), session)
									if (Option.isNone(route)) return
									if (route.value._tag === "Here")
										yield* deliverTo(route.value.sink, message)
									else yield* forward(session, route.value.order, message)
									if (message._tag === "Exit")
										yield* Ref.update(sessions, HashMap.remove(session))
								}
							})
						// A message that does not decode is left out. A socket that closes ends the loop.
						const receive = Stream.fromIterableEffectRepeat(next).pipe(
							Stream.mapEffect((text) =>
								decodeFrom(text).pipe(
									Effect.tapError((error) =>
										Effect.logDebug(
											"A connector message does not decode",
											Cause.fail(error),
										),
									),
									Effect.option,
								),
							),
							Stream.runForEach(
								Option.match({ onNone: () => Effect.void, onSome: onMessage }),
							),
							Effect.catchReason(
								"SocketError",
								"SocketCloseError",
								() => Effect.void,
							),
							Effect.catch((error) =>
								Effect.logDebug(
									"OpenBot could not read from a connector",
									Cause.fail(error),
								),
							),
						)
						yield* Effect.raceAll([heartbeat, receive, Deferred.await(closed)])
						yield* writer
							.write(new Socket.CloseEvent(1000, "closed"))
							.pipe(logWriteFailure)
					}),
				).pipe(
					// Every socket ends with a close, so a close is no failure.
					Effect.catchReason(
						"SocketError",
						"SocketCloseError",
						() => Effect.void,
					),
					Effect.catch((error) =>
						Effect.logInfo("A connector connection failed", Cause.fail(error)),
					),
					Effect.ensuring(
						Effect.gen(function* () {
							// Only a connection that is still stored removes itself, so a new connection stays.
							const mine = yield* Ref.modify(locals, (map) =>
								Option.exists(
									HashMap.get(map, computerId),
									(current) => current.id === id,
								)
									? ([true, HashMap.remove(map, computerId)] as const)
									: ([false, map] as const),
							)
							// After a replace, the new connection owns the state of the Computer.
							const replaced =
								(yield* Deferred.isDone(closed)) &&
								(yield* Deferred.await(closed))
							if (mine && !replaced) yield* offline
						}),
					),
					Effect.annotateLogs({ computer: computerId, connection: id }),
				)
			}),
		call: (computerId, operation, wait = defaultWait) =>
			Effect.gen(function* () {
				const call: ComputersApi.ConnectorCall = {
					id: yield* newUuid,
					operation,
				}
				const found = yield* local(computerId)
				const result = Option.isSome(found)
					? yield* callLocal(found.value, call, wait)
					: (yield* isConnected(computerId))
						? yield* callRemote(computerId, call, wait)
						: yield* ComputerGone.make({
								reason: "The machine is not connected.",
							})
				if (Option.isNone(result))
					return yield* ComputerCallFailed.make({
						message: "The machine did not answer in time.",
						retry: true,
					})
				if (result.value._tag === "Failed")
					return yield* ComputerCallFailed.make({
						message: result.value.message,
						retry: false,
					})
				return result.value.value
			}),
		close: (computerId) =>
			Effect.gen(function* () {
				const found = yield* local(computerId)
				if (Option.isSome(found)) yield* found.value.close
				else
					yield* notify(closeNotice(computerId, "")).pipe(
						Background.logFailure(
							"OpenBot could not send a connector close notice",
						),
					)
			}),
		start: (computerId, request) =>
			Effect.gen(function* () {
				const session = yield* newUuid
				const sink = yield* ProcessSink.make
				const found = yield* local(computerId)
				if (Option.isSome(found))
					yield* Ref.update(
						found.value.sessions,
						HashMap.set<string, Route>(session, Route.Here({ sink })),
					)
				else if (yield* isConnected(computerId))
					yield* Ref.update(
						owned,
						HashMap.set(session, {
							computerId,
							sink,
							reorder: yield* Ref.make<Reorder>({
								next: 0,
								early: HashMap.empty(),
								gapSince: Option.none(),
							}),
						}),
					)
				else
					return yield* ComputerGone.make({
						reason: "The machine is not connected.",
					})
				const send = (message: ComputersApi.ToConnector) =>
					Option.isSome(found)
						? found.value.send(message)
						: notifySession({ to: computerId, message })
				yield* Effect.addFinalizer(() =>
					Effect.gen(function* () {
						if (!(yield* sink.ended)) yield* send({ _tag: "Close", session })
						yield* Ref.update(owned, HashMap.remove(session))
						if (Option.isSome(found))
							yield* Ref.update(found.value.sessions, HashMap.remove(session))
					}),
				)
				yield* send({
					_tag: "Start",
					session,
					command: request.command,
					tty: request.tty,
					...(request.cwd === undefined ? {} : { cwd: request.cwd }),
					...(request.env === undefined ? {} : { env: request.env }),
					...(request.rows === undefined ? {} : { rows: request.rows }),
					...(request.cols === undefined ? {} : { cols: request.cols }),
				})
				const process: Process = {
					output: sink.output,
					exit: sink.exit,
					write: (data) =>
						send({ _tag: "Input", session, data: Base64.encode(data) }),
					resize: (rows, cols) => send({ _tag: "Resize", session, rows, cols }),
					signal: (signal) => send({ _tag: "Signal", session, signal }),
				}
				return process
			}),
		removeOld: (before) =>
			db
				.delete(computerCalls)
				.where(lt(computerCalls.createdAt, before))
				.pipe(
					Background.logFailure("OpenBot could not remove old Computer calls"),
				),
	})
})
export const layer = Layer.effect(Connectors, make)
