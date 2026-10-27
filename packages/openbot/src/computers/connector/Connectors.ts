import { Computers as ComputerData } from "@openbot-build/domain"
import { Execution, type ExecutionIdentity } from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Context,
	Crypto,
	Deferred,
	Duration,
	Effect,
	HashMap,
	Layer,
	Option,
	Queue,
	Ref,
	Schema,
	Scope,
	Stream,
} from "effect"
import { Base64 } from "effect/encoding"
import { Socket } from "effect/socket"
import { Records } from "../../errors/Records.ts"
import * as Background from "../../execution/Background.ts"
import * as Send from "../../execution/Send.ts"
import { Transport, type Handler } from "../../resources/Transport.ts"
import * as Resource from "../../resources/Resource.ts"
import { Directory } from "../../resources/Directory.ts"
import * as Access from "../Access.ts"
import {
	ComputerCallFailed,
	ComputerGone,
	type ComputerFailure,
	type Process,
	type StartRequest,
} from "../Computer.ts"
import * as ProcessSink from "../Process.ts"

export const pingEvery = Duration.seconds(20)
const defaultWait = Duration.minutes(2)
export const oldConnector =
	"This openbot-computer is too old. Update it, and then connect again."

type Operation = ComputerData.ConnectorCall["operation"]
type Result = ComputerData.ConnectorReply["result"]
const To = ComputerData.ToConnector.cases
const Message = Schema.Union([
	ComputerData.FromConnector.cases.Output,
	ComputerData.FromConnector.cases.Exit,
])
type Message = typeof Message.Type
const Request = Schema.TaggedUnion({
	Call: {
		authority: Send.Authority,
		call: ComputerData.ConnectorCall,
		wait: Schema.Finite.check(Schema.isGreaterThan(0)),
	},
	Start: { authority: Send.Authority, message: To.Start },
	Session: {
		authority: Send.Authority,
		message: Schema.Union([To.Input, To.Resize, To.Signal]),
	},
})
const Reply = Schema.TaggedUnion({
	Result: { result: ComputerData.ConnectorReply.fields.result },
	Ready: {},
	Message: { message: Message },
})
const requestCodec = Schema.toCodecJson(Request)
const replyCodec = Schema.toCodecJson(Reply)
const encodeTo = Schema.encodeEffect(
	Schema.fromJsonString(ComputerData.ToConnector),
)
const decodeFrom = Schema.decodeUnknownEffect(
	Schema.fromJsonString(ComputerData.FromConnector),
)
const resource = (
	organizationId: string,
	computerId: string,
): Resource.Ref => ({
	namespace: organizationId,
	kind: "computer-connector",
	id: computerId,
})
class OutputLost extends Schema.TaggedError<
	OutputLost,
	{ readonly brand: unique symbol }
>()("ConnectorOutputLost", { session: ComputerData.ConnectorSessionId }) {}
interface Session {
	readonly identity: ExecutionIdentity
	readonly queue: Queue.Queue<Message, OutputLost | Cause.Done>
	readonly next: Ref.Ref<number>
}
const sameOwner = (a: ExecutionIdentity, b: ExecutionIdentity) =>
	a.owner.organizationId === b.owner.organizationId &&
	a.owner.userId === b.owner.userId &&
	a.botId === b.botId

export const make = Effect.gen(function* () {
	const background = yield* Background.make
	const crypto = yield* Crypto.Crypto
	const transport = yield* Transport
	const directory = yield* Directory
	const access = yield* Access.make
	const sendAccess = yield* Send.Access
	const errors = yield* Records
	const uuid = crypto.randomUUIDv4().pipe(Effect.orDie)
	const safe = <A, E, R>(
		effect: Effect.Effect<A, E, R>,
	): Effect.Effect<A, ComputerFailure, R> =>
		effect.pipe(
			Effect.catchCause((cause): Effect.Effect<never, ComputerFailure> => {
				if (Cause.hasInterruptsOnly(cause))
					return Effect.failCause(
						Cause.fromReasons<never>(
							Arr.filter(cause.reasons, Cause.isInterruptReason),
						),
					)
				const reason = cause.reasons[0]
				if (cause.reasons.length === 1 && reason?._tag === "Fail") {
					const error = reason.error
					if (
						Schema.is(ComputerCallFailed)(error) ||
						Schema.is(ComputerGone)(error) ||
						Schema.is(Execution.Failure)(error)
					)
						return Effect.failCause(Cause.map(cause, () => error))
					if (Schema.is(Resource.Gone)(error))
						return Effect.fail(
							ComputerGone.make({ message: "The machine is not connected." }),
						)
					if (Schema.is(Resource.Failed)(error))
						return Effect.fail({
							...error.failure,
							category:
								error.outcome === "unknown"
									? "outcome_unknown"
									: error.failure.category,
						})
				}
				return errors
					.record(cause, "outcome_unknown")
					.pipe(Effect.orDie, Effect.flatMap(Effect.fail))
			}),
		)
	const rpc = (
		identity: ExecutionIdentity,
		id: string,
		request: typeof Request.Type,
	) =>
		Stream.unwrap(
			Effect.map(Schema.encodeEffect(requestCodec)(request), (raw) =>
				transport.call(resource(identity.owner.organizationId, id), raw),
			),
		).pipe(Stream.mapEffect((raw) => Schema.decodeEffect(replyCodec)(raw)))
	const once = (
		identity: ExecutionIdentity,
		id: string,
		request: typeof Request.Type,
	) =>
		rpc(identity, id, request).pipe(
			Stream.runCollect,
			Effect.flatMap((rows) =>
				rows.length === 1
					? Effect.succeed(rows[0]!)
					: Effect.die("The connector RPC gave the wrong number of replies."),
			),
			safe,
		)
	const beforeSend = <A, E>(ref: Resource.Ref, work: Effect.Effect<A, E>) =>
		work.pipe(
			Effect.catchCause((cause) => {
				if (Cause.hasInterruptsOnly(cause))
					return Effect.failCause(
						Cause.fromReasons<never>(
							Arr.filter(cause.reasons, Cause.isInterruptReason),
						),
					)
				const forbidden = Arr.some(
					cause.reasons,
					(reason) =>
						reason._tag === "Fail" &&
						typeof reason.error === "object" &&
						reason.error !== null &&
						"_tag" in reason.error &&
						[
							"ExecutionForbidden",
							"ComputerNotFound",
							"Forbidden",
							"Pending",
						].includes(String(reason.error._tag)),
				)
				return errors
					.record(cause, forbidden ? "forbidden" : "unavailable")
					.pipe(
						Effect.orDie,
						Effect.flatMap((failure) =>
							Effect.fail(
								Resource.Failed.make({
									resource: ref,
									outcome: "not_sent",
									failure,
								}),
							),
						),
					)
			}),
		)
	const authorize = (ref: Resource.Ref, authority: Send.Authority) =>
		Effect.gen(function* () {
			const identity = yield* sendAccess.resolve(authority)
			if (identity.owner.organizationId !== ref.namespace)
				return yield* Execution.Forbidden.make({})
			yield* access.execution(identity, ref.id, "use")
			return identity
		})

	const serve = (input: {
		readonly organizationId: string
		readonly computerId: string
		readonly socket: Socket.Socket
		readonly online: (
			hello: ComputerData.ConnectorHello,
		) => Effect.Effect<void, ComputerData.ComputersUnavailable>
		readonly offline: Effect.Effect<void, ComputerData.ComputersUnavailable>
	}) =>
		Effect.scoped(
			Effect.gen(function* () {
				const ref = resource(input.organizationId, input.computerId)
				const ready = yield* Deferred.make<Handler<unknown>>()
				return yield* transport.own(
					ref,
					(raw) =>
						Stream.unwrap(
							Effect.map(Deferred.await(ready), (handle) => handle(raw)),
						),
					{ admit: Effect.void, replace: true },
					(held) =>
						Effect.gen(function* () {
							const reader = yield* input.socket.reader
							const writer = yield* input.socket.writer
							const send = (message: ComputerData.ToConnector) =>
								encodeTo(message).pipe(
									Effect.orDie,
									Effect.flatMap(writer.write),
								)
							const next = reader.pull.pipe(
								Effect.map((frames) =>
									Arr.map(frames, (frame) =>
										typeof frame === "string"
											? frame
											: new TextDecoder().decode(frame),
									),
								),
							)
							const first = yield* next
							const hello = yield* decodeFrom(first[0])
							if (hello._tag !== "Hello") return
							if (hello.hello.version < ComputerData.connectorProtocolVersion) {
								yield* writer.write(new Socket.CloseEvent(4426, oldConnector))
								return
							}
							const waiting = yield* Ref.make(
								HashMap.empty<string, Deferred.Deferred<Result>>(),
							)
							const sessions = yield* Ref.make(
								HashMap.empty<ComputerData.ConnectorSessionId, Session>(),
							)
							const handler = (raw: Schema.Json) =>
								Stream.unwrap(
									Effect.gen(function* () {
										const request = yield* beforeSend(
											ref,
											Schema.decodeEffect(requestCodec)(raw),
										)
										const identity = yield* beforeSend(
											ref,
											authorize(ref, request.authority),
										)
										if (request._tag === "Call")
											return Stream.fromEffect(
												Effect.gen(function* () {
													const done = yield* Deferred.make<Result>()
													return yield* Effect.acquireUseRelease(
														Ref.update(
															waiting,
															HashMap.set(request.call.id, done),
														),
														() =>
															send({ _tag: "Call", call: request.call }).pipe(
																Effect.andThen(Deferred.await(done)),
																Effect.timeout(Duration.millis(request.wait)),
																Effect.map((result) =>
																	Reply.cases.Result.make({ result }),
																),
															),
														() =>
															Ref.update(
																waiting,
																HashMap.remove(request.call.id),
															),
													)
												}),
											)
										const message = request.message
										if (request._tag === "Session")
											return Stream.fromEffect(
												Effect.gen(function* () {
													const found = HashMap.get(
														yield* Ref.get(sessions),
														message.session,
													)
													if (
														Option.isNone(found) ||
														!sameOwner(found.value.identity, identity)
													)
														return yield* Resource.Gone.make({ resource: ref })
													yield* send(message)
													return Reply.cases.Ready.make({})
												}),
											)
										const session: Session = {
											identity,
											queue: yield* Queue.dropping<
												Message,
												OutputLost | Cause.Done
											>(32),
											next: yield* Ref.make(0),
										}
										yield* Effect.acquireRelease(
											Ref.update(
												sessions,
												HashMap.set(message.session, session),
											),
											() =>
												Ref.modify(sessions, (all) => [
													HashMap.has(all, message.session),
													HashMap.remove(all, message.session),
												]).pipe(
													Effect.flatMap((running) =>
														running
															? send({
																	_tag: "Close",
																	session: message.session,
																}).pipe(
																	Effect.timeout("5 seconds"),
																	background.logFailure(
																		"A connector process could not close.",
																	),
																)
															: Effect.void,
													),
												),
										)
										yield* send(message)
										return Stream.concat(
											Stream.succeed(Reply.cases.Ready.make({})),
											Stream.fromQueue(session.queue).pipe(
												Stream.map((message) =>
													Reply.cases.Message.make({ message }),
												),
											),
										)
									}).pipe(
										Effect.map(
											(
												stream,
											): Stream.Stream<
												typeof Reply.Type,
												| Socket.SocketError
												| Cause.TimeoutError
												| Resource.Gone
												| OutputLost
											> => stream,
										),
									),
								).pipe(
									Stream.mapEffect((reply) =>
										Schema.encodeEffect(replyCodec)(reply),
									),
								)
							yield* Deferred.succeed(ready, handler)
							const active = yield* directory.commit(
								held.address,
								input.online(hello.hello),
							)
							if (Option.isNone(active)) return
							const unanswered = yield* Ref.make(0)
							const heartbeat = Ref.modify(unanswered, (count) =>
								count >= 2 ? [false, count] : [true, count + 1],
							).pipe(
								Effect.tap((alive) =>
									alive ? send({ _tag: "Ping" }) : Effect.void,
								),
								Effect.delay(pingEvery),
								Effect.repeat({ while: (alive) => alive }),
							)
							const onMessage = (message: ComputerData.FromConnector) =>
								Effect.gen(function* () {
									if (message._tag === "Pong") yield* Ref.set(unanswered, 0)
									else if (message._tag === "Reply") {
										const done = HashMap.get(
											yield* Ref.get(waiting),
											message.reply.id,
										)
										if (Option.isSome(done))
											yield* Deferred.succeed(done.value, message.reply.result)
									} else if (
										message._tag === "Output" ||
										message._tag === "Exit"
									) {
										const found = HashMap.get(
											yield* Ref.get(sessions),
											message.session,
										)
										if (Option.isNone(found)) return
										const session = found.value
										const inOrder =
											message._tag === "Exit" ||
											message.seq ===
												(yield* Ref.getAndUpdate(session.next, (n) => n + 1))
										if (
											!inOrder ||
											!(yield* Queue.offer(session.queue, message))
										) {
											yield* Queue.fail(
												session.queue,
												OutputLost.make({ session: message.session }),
											)
											// The stream finalizer closes only this process. Other replies keep moving.
											return
										}
										if (message._tag === "Exit") {
											yield* Ref.update(
												sessions,
												HashMap.remove(message.session),
											)
											yield* Queue.end(session.queue)
										}
									}
								})
							const receive = Stream.concat(
								Stream.fromIterable(Arr.drop(first, 1)),
								Stream.fromIterableEffectRepeat(next),
							).pipe(
								Stream.mapEffect((raw) => decodeFrom(raw)),
								Stream.runForEach(onMessage),
							)
							yield* Effect.raceAllFirst([heartbeat, receive, held.lost]).pipe(
								Effect.ensuring(
									writer
										.write(new Socket.CloseEvent(1000, "closed"))
										.pipe(Effect.orDie),
								),
								Effect.ensuring(
									directory
										.commit(held.address, input.offline)
										.pipe(
											background.logFailure(
												"The connector state could not close.",
											),
										),
								),
							)
						}),
				)
			}),
		).pipe(
			Effect.catchIf(
				(error): error is Socket.SocketError =>
					Schema.is(Socket.SocketError)(error) &&
					error.reason._tag === "SocketCloseError",
				() => Effect.void,
			),
			background.logFailure("A connector connection ended with a failure."),
		)
	const call = (
		identity: ExecutionIdentity,
		computerId: string,
		operation: Operation,
		wait = defaultWait,
	) =>
		Effect.gen(function* () {
			const reply = yield* once(identity, computerId, {
				_tag: "Call",
				authority: yield* Send.authority(identity),
				call: { id: yield* uuid, operation },
				wait: Duration.toMillis(wait),
			})
			if (reply._tag !== "Result")
				return yield* Effect.die(
					"The connector RPC did not give a call result.",
				)
			if (reply.result._tag === "Failed")
				return yield* ComputerCallFailed.make({
					message: reply.result.message,
					retry: false,
					...(reply.result.reason === "NotFound" && "path" in operation
						? { missingPath: operation.path }
						: {}),
				})
			return reply.result.value
		}).pipe(safe)
	const start = (
		identity: ExecutionIdentity,
		computerId: string,
		request: StartRequest,
	): Effect.Effect<Process, ComputerFailure, Scope.Scope> =>
		Effect.gen(function* () {
			const session = ComputerData.ConnectorSessionId.make(yield* uuid)
			const sink = yield* ProcessSink.make
			const ready = yield* Deferred.make<void, ComputerFailure>()
			const requestAuthority = yield* Send.authority(identity)
			const receive = rpc(identity, computerId, {
				_tag: "Start",
				authority: requestAuthority,
				message: { _tag: "Start", session, ...request },
			}).pipe(
				Stream.runForEach((reply) =>
					Effect.gen(function* () {
						if (reply._tag === "Ready") {
							yield* Deferred.succeed(ready, undefined)
							return
						}
						if (reply._tag !== "Message")
							return yield* Effect.die(
								"The connector sent the wrong process reply.",
							)
						const message = reply.message
						if (message._tag === "Output")
							yield* sink.push(
								yield* Effect.fromResult(Base64.decode(message.data)),
							)
						else
							yield* sink.end({
								code: message.code,
								signal: message.signal,
								...(message.error === undefined
									? {}
									: { error: message.error }),
							})
					}),
				),
				safe,
				Effect.catch((error) =>
					Effect.gen(function* () {
						yield* Deferred.fail(ready, error)
						const failure = Schema.is(Execution.Failure)(error)
							? error
							: yield* errors
									.record(Cause.fail(error), "outcome_unknown")
									.pipe(Effect.orDie)
						yield* sink.end({ code: null, signal: null, failure })
					}),
				),
			)
			yield* Effect.forkScoped(receive)
			yield* Deferred.await(ready)
			const send = (
				message: typeof Request.Type & { readonly _tag: "Session" },
			) => once(identity, computerId, message).pipe(Effect.asVoid)
			const control = (
				message: Extract<typeof Request.Type, { _tag: "Session" }>["message"],
			) =>
				Effect.flatMap(Send.authority(identity), (authority) =>
					send({ _tag: "Session", authority, message }),
				)
			return {
				output: sink.output,
				exit: sink.exit,
				write: (data: Uint8Array) =>
					control({ _tag: "Input", session, data: Base64.encode(data) }),
				resize: (rows: number, cols: number) =>
					control({ _tag: "Resize", session, rows, cols }),
				signal: (signal: ComputerData.SessionSignal) =>
					control({ _tag: "Signal", session, signal }),
			}
		}).pipe(safe)
	return {
		serve,
		call,
		start,
		close: (organizationId: string, id: string) =>
			transport
				.close(resource(organizationId, id))
				.pipe(background.logFailure("A connector could not close.")),
	}
})

/** Physical sockets share the resource transport. Commands and output are never stored in notices. */
export class Connectors extends Context.Service<
	Connectors,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/computers/connector/Connectors") {}
export const layer = Layer.effect(Connectors, make)
