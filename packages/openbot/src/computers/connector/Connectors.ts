import { randomUUID } from "node:crypto"
import { ComputersApi } from "@openbot-build/api"
import { PgClient } from "@effect/sql-pg"
import { eq, lt } from "drizzle-orm"
import {
	Clock,
	Context,
	Deferred,
	Duration,
	Effect,
	Fiber,
	HashMap,
	Layer,
	Option,
	PubSub,
	Queue,
	Result,
	Schedule,
	Schema,
	Scope,
	Stream,
	SynchronizedRef,
} from "effect"
import { Base64 } from "effect/encoding"
import { Socket } from "effect/socket"
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
const encodeSessionNotice = Schema.encodeSync(
	Schema.fromJsonString(SessionNotice),
)
const decodeSessionNotice = Schema.decodeUnknownOption(
	Schema.fromJsonString(SessionNotice),
)

/** Where the output of a session goes on the instance with the connection. */
type Route =
	| { readonly _tag: "Here"; readonly sink: ProcessSink.Sink }
	| { readonly _tag: "Away"; readonly order: { value: number } }

/** A session that this instance started on a connection of another instance. */
interface Owned {
	readonly sink: ProcessSink.Sink
	/** The order of the next message, and the messages that came too early. */
	next: number
	readonly early: Map<number, ComputersApi.FromConnector>
}

const closedExit: Exit = {
	code: null,
	signal: null,
	error: "The connection to the machine closed.",
}

/** OpenBot pings each connector this often. Two missed pongs close the connection. */
export const pingEvery = Duration.seconds(20)

/** The longest wait for a reply when the call has no timeout of its own. */
const defaultWait = Duration.minutes(2)

const encodeTo = Schema.encodeSync(
	Schema.fromJsonString(ComputersApi.ToConnector),
)
const decodeFrom = Schema.decodeUnknownEffect(
	Schema.fromJsonString(ComputersApi.FromConnector),
)
const encodeCall = Schema.encodeSync(
	Schema.fromJsonString(ComputersApi.ConnectorCall),
)
const decodeCall = Schema.decodeUnknownSync(
	Schema.fromJsonString(ComputersApi.ConnectorCall),
)
const encodeReply = Schema.encodeSync(
	Schema.fromJsonString(ComputersApi.ConnectorReply),
)
const decodeReply = Schema.decodeUnknownSync(
	Schema.fromJsonString(ComputersApi.ConnectorReply),
)

type Operation = ComputersApi.ConnectorCall["operation"]
type Result = ComputersApi.ConnectorReply["result"]

/** A connection on this instance. */
interface Local {
	/** The ID of this connection, so a close notice can keep it. */
	readonly id: string
	readonly send: (message: ComputersApi.ToConnector) => Effect.Effect<void>
	readonly close: Effect.Effect<void>
	readonly waiting: SynchronizedRef.SynchronizedRef<
		HashMap.HashMap<string, Deferred.Deferred<Result>>
	>
	/** The command sessions on this connection. */
	readonly sessions: SynchronizedRef.SynchronizedRef<
		HashMap.HashMap<string, Route>
	>
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
		 * and `offline` when it goes.
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
		) => Effect.Effect<Process, ComputerGone, Scope.Scope>
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
	const scope = yield* Scope.Scope
	const locals = yield* SynchronizedRef.make(HashMap.empty<string, Local>())
	const replies = yield* PubSub.unbounded<string>()
	yield* Effect.addFinalizer(() => PubSub.shutdown(replies))

	const notify = (payload: string) =>
		client.notify(channel, payload).pipe(Effect.ignore)
	const notifySession = (value: typeof SessionNotice.Type) =>
		client
			.notify(sessionChannel, encodeSessionNotice(value))
			.pipe(Effect.ignore)
	const owned = new Map<string, Owned>()

	/** Gives a message of the machine to the sink of its session. */
	const deliverTo = (
		sink: ProcessSink.Sink,
		message: ComputersApi.FromConnector,
	) =>
		message._tag === "Output"
			? sink.push(
					Result.getOrElse(
						Base64.decode(message.data),
						() => new Uint8Array(0),
					),
				)
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
		order: { value: number },
		message: ComputersApi.FromConnector,
	) =>
		Effect.gen(function* () {
			if (message._tag !== "Output") {
				yield* notifySession({ from: session, order: order.value++, message })
				return
			}
			for (let at = 0; at < message.data.length; at += partLength)
				yield* notifySession({
					from: session,
					order: order.value++,
					message: {
						...message,
						data: message.data.slice(at, at + partLength),
					},
				})
		})

	/** A message of a session from another instance. */
	const onSessionNotice = (payload: string) =>
		Effect.gen(function* () {
			const parsed = decodeSessionNotice(payload)
			if (Option.isNone(parsed)) return
			const value = parsed.value
			if ("to" in value) {
				const found = yield* local(value.to)
				if (Option.isNone(found)) return
				const message = value.message
				if (message._tag === "Start")
					yield* SynchronizedRef.update(
						found.value.sessions,
						HashMap.set(message.session, {
							_tag: "Away",
							order: { value: 0 },
						} as Route),
					)
				yield* found.value.send(message)
				return
			}
			const target = owned.get(value.from)
			if (target === undefined) return
			target.early.set(value.order, value.message)
			while (target.early.has(target.next)) {
				const message = target.early.get(target.next)!
				target.early.delete(target.next)
				target.next++
				yield* deliverTo(target.sink, message)
				if (message._tag === "Exit") owned.delete(value.from)
			}
		})

	yield* Effect.scoped(
		Effect.gen(function* () {
			const notices = yield* client.listen(sessionChannel)
			while (true) {
				const { payload } = yield* Queue.take(notices)
				yield* onSessionNotice(payload)
			}
		}),
	).pipe(
		Effect.tapError((error) =>
			Effect.logWarning(
				"The session listener stopped. It starts again.",
				error,
			),
		),
		Effect.retry(Schedule.spaced(Duration.seconds(1))),
		Effect.forkScoped,
	)

	const local = (computerId: string) =>
		Effect.map(SynchronizedRef.get(locals), HashMap.get(computerId))

	/** Sends a call to a connection on this instance and waits for its result. */
	const callLocal = (
		connection: Local,
		call: ComputersApi.ConnectorCall,
		wait: Duration.Duration,
	) =>
		Effect.gen(function* () {
			const done = yield* Deferred.make<Result>()
			yield* SynchronizedRef.update(
				connection.waiting,
				HashMap.set(call.id, done),
			)
			yield* connection.send({ _tag: "Call", call })
			return yield* Deferred.await(done).pipe(
				Effect.timeoutOption(wait),
				Effect.ensuring(
					SynchronizedRef.update(connection.waiting, HashMap.remove(call.id)),
				),
			)
		})

	/** Another instance asked for a call. Pass it on when the connection is here. */
	const onCall = (id: string) =>
		Effect.gen(function* () {
			const row = (yield* db
				.select()
				.from(computerCalls)
				.where(eq(computerCalls.id, id))
				.pipe(Effect.orElseSucceed(() => [])))[0]
			if (row === undefined || row.reply !== null) return
			const found = yield* local(row.computerId)
			if (Option.isNone(found)) return
			const call = decodeCall(row.call)
			const result = yield* callLocal(found.value, call, defaultWait)
			if (Option.isNone(result)) return
			yield* db
				.update(computerCalls)
				.set({ reply: encodeReply({ id, result: result.value }) })
				.where(eq(computerCalls.id, id))
				.pipe(Effect.ignore)
			yield* notify(notice("reply", id))
		})

	const listen = Effect.scoped(
		Effect.gen(function* () {
			const notices = yield* client.listen(channel)
			while (true) {
				const { payload } = yield* Queue.take(notices)
				const split = payload.indexOf(":")
				const kind = payload.slice(0, split)
				const id = payload.slice(split + 1)
				if (kind === "call") yield* Effect.forkIn(onCall(id), scope)
				else if (kind === "reply") yield* PubSub.publish(replies, id)
				else if (kind === "close") {
					const [computerId = "", keep = ""] = id.split("/")
					const found = yield* local(computerId)
					if (Option.isSome(found) && found.value.id !== keep)
						yield* found.value.close
				}
			}
		}),
	)
	yield* listen.pipe(
		Effect.tapError((error) =>
			Effect.logWarning(
				"The connector listener stopped. It starts again.",
				error,
			),
		),
		Effect.retry(Schedule.spaced(Duration.seconds(1))),
		Effect.forkScoped,
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
						call: encodeCall(call),
						createdAt: now,
					})
					.pipe(
						Effect.mapError(
							() =>
								new ComputerCallFailed({
									message: "OpenBot could not store the call.",
									retry: true,
								}),
						),
					)
				yield* notify(notice("call", call.id))
				const replied = yield* Stream.fromSubscription(subscription).pipe(
					Stream.filter((id) => id === call.id),
					Stream.runHead,
					Effect.timeoutOption(wait),
				)
				const row = (yield* db
					.select()
					.from(computerCalls)
					.where(eq(computerCalls.id, call.id))
					.pipe(Effect.orElseSucceed(() => [])))[0]
				yield* db
					.delete(computerCalls)
					.where(eq(computerCalls.id, call.id))
					.pipe(Effect.ignore)
				if (Option.isNone(replied) || row?.reply == null)
					return Option.none<Result>()
				return Option.some(decodeReply(row.reply).result)
			}),
		)

	const isConnected = (computerId: string) =>
		db
			.select({ state: computers.state })
			.from(computers)
			.where(eq(computers.id, computerId))
			.pipe(
				Effect.map((rows) => rows[0]?.state === "running"),
				Effect.orElseSucceed(() => false),
			)

	return Connectors.of({
		serve: ({ computerId, socket, online, offline }) =>
			Effect.scoped(
				Effect.gen(function* () {
					// The reader does the handshake, and the writer waits for it, so the reader comes first.
					const reader = yield* socket.reader
					const writer = yield* socket.writer
					const send = (message: ComputersApi.ToConnector) =>
						writer.write(encodeTo(message)).pipe(Effect.ignore)
					const waiting = yield* SynchronizedRef.make(
						HashMap.empty<string, Deferred.Deferred<Result>>(),
					)
					const closed = yield* Deferred.make<void>()
					const sessions = yield* SynchronizedRef.make(
						HashMap.empty<string, Route>(),
					)
					const connection: Local = {
						id: randomUUID(),
						send,
						close: Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
						waiting,
						sessions,
					}
					// The machine stops its sessions when the connection closes.
					yield* Effect.addFinalizer(() =>
						SynchronizedRef.get(sessions).pipe(
							Effect.flatMap((current) =>
								Effect.forEach(
									current,
									([session, route]) =>
										route._tag === "Here"
											? route.sink.end(closedExit)
											: notifySession({
													from: session,
													order: route.order.value++,
													message: {
														_tag: "Exit",
														session,
														code: null,
														signal: null,
														error: closedExit.error!,
													},
												}),
									{ discard: true },
								),
							),
						),
					)
					const decoder = new TextDecoder()
					const next = reader.pull.pipe(
						Effect.map((frames) =>
							frames.map((frame) =>
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
							.pipe(Effect.ignore)
						return
					}
					// A new connection of the same Computer replaces the old one.
					const previous = yield* local(computerId)
					if (Option.isSome(previous)) yield* previous.value.close
					else yield* notify(closeNotice(computerId, connection.id))
					yield* SynchronizedRef.update(
						locals,
						HashMap.set(computerId, connection),
					)
					yield* online(hello.hello)
					let pongs = 0
					let pings = 0
					const heartbeat = Effect.gen(function* () {
						while (true) {
							yield* Effect.sleep(pingEvery)
							if (pings - pongs >= 2) return
							pings++
							yield* send({ _tag: "Ping" })
						}
					})
					const receive = Effect.gen(function* () {
						while (true) {
							for (const text of yield* next) {
								const message = yield* decodeFrom(text).pipe(Effect.option)
								if (Option.isNone(message)) continue
								if (message.value._tag === "Pong") pongs = pings
								else if (message.value._tag === "Reply") {
									const reply = message.value.reply
									const done = HashMap.get(
										yield* SynchronizedRef.get(waiting),
										reply.id,
									)
									if (Option.isSome(done))
										yield* Deferred.succeed(done.value, reply.result)
								} else if (
									message.value._tag === "Output" ||
									message.value._tag === "Exit"
								) {
									const session = message.value.session
									const route = HashMap.get(
										yield* SynchronizedRef.get(sessions),
										session,
									)
									if (Option.isNone(route)) continue
									if (route.value._tag === "Here")
										yield* deliverTo(route.value.sink, message.value)
									else yield* forward(session, route.value.order, message.value)
									if (message.value._tag === "Exit")
										yield* SynchronizedRef.update(
											sessions,
											HashMap.remove(session),
										)
								}
							}
						}
					})
					const fibers = [
						yield* Effect.forkScoped(heartbeat),
						yield* Effect.forkScoped(Effect.ignore(receive)),
						yield* Effect.forkScoped(Deferred.await(closed)),
					]
					yield* Effect.raceAll(fibers.map(Fiber.join)).pipe(Effect.ignore)
					yield* writer
						.write(new Socket.CloseEvent(1000, "closed"))
						.pipe(Effect.ignore)
				}).pipe(
					Effect.ignore,
					Effect.ensuring(
						Effect.gen(function* () {
							const removed = yield* SynchronizedRef.modify(locals, (map) => {
								const current = HashMap.get(map, computerId)
								return [current, HashMap.remove(map, computerId)] as const
							})
							if (Option.isSome(removed)) yield* offline
						}),
					),
				),
			),
		call: (computerId, operation, wait = defaultWait) =>
			Effect.gen(function* () {
				const call: ComputersApi.ConnectorCall = {
					id: randomUUID(),
					operation,
				}
				const found = yield* local(computerId)
				const result = Option.isSome(found)
					? yield* callLocal(found.value, call, wait)
					: (yield* isConnected(computerId))
						? yield* callRemote(computerId, call, wait)
						: yield* new ComputerGone({
								reason: "The machine is not connected.",
							})
				if (Option.isNone(result))
					return yield* new ComputerCallFailed({
						message: "The machine did not answer in time.",
						retry: true,
					})
				if (result.value._tag === "Failed")
					return yield* new ComputerCallFailed({
						message: result.value.message,
						retry: false,
					})
				return result.value.value
			}),
		close: (computerId) =>
			Effect.gen(function* () {
				const found = yield* local(computerId)
				if (Option.isSome(found)) yield* found.value.close
				else yield* notify(closeNotice(computerId, ""))
			}),
		start: (computerId, request) =>
			Effect.gen(function* () {
				const session: string = randomUUID()
				const sink = yield* ProcessSink.make
				const found = yield* local(computerId)
				if (Option.isSome(found))
					yield* SynchronizedRef.update(
						found.value.sessions,
						HashMap.set(session, { _tag: "Here", sink } as Route),
					)
				else if (yield* isConnected(computerId))
					owned.set(session, { sink, next: 0, early: new Map() })
				else
					return yield* new ComputerGone({
						reason: "The machine is not connected.",
					})
				const send = (message: ComputersApi.ToConnector) =>
					Option.isSome(found)
						? found.value.send(message)
						: notifySession({ to: computerId, message })
				yield* Effect.addFinalizer(() =>
					Effect.gen(function* () {
						if (!(yield* sink.ended)) yield* send({ _tag: "Close", session })
						owned.delete(session)
						if (Option.isSome(found))
							yield* SynchronizedRef.update(
								found.value.sessions,
								HashMap.remove(session),
							)
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
	})
})
export const layer = Layer.effect(Connectors, make)

/** Removes calls that nobody took, such as after an instance stopped. */
export const removeOld = (before: number) =>
	Effect.gen(function* () {
		const db = yield* Db.make
		yield* db.delete(computerCalls).where(lt(computerCalls.createdAt, before))
	})
