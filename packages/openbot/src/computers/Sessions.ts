import {
	Computers as ComputerData,
	Execution,
	ExecutionIdentity,
	executionCallers,
} from "@openbot-build/domain"
import { Chat } from "@openbot-build/core"
import {
	Array as Arr,
	Cause,
	Chunk,
	Clock,
	Context,
	Crypto,
	Deferred,
	Duration,
	Effect,
	Exit as EffectExit,
	HashMap,
	Layer,
	Option,
	pipe,
	Ref,
	Schedule,
	Schema,
	Scope,
	Semaphore,
	Stream,
	String as Str,
} from "effect"
import * as Background from "../execution/Background.ts"
import * as Send from "../execution/Send.ts"
import { Records } from "../errors/Records.ts"
import * as Resource from "../resources/Resource.ts"
import { Transport } from "../resources/Transport.ts"
import {
	ComputerCallFailed,
	ComputerGone,
	type ComputerError,
	type Exit,
	type Machine,
	type Process,
} from "./Computer.ts"
import { Computers } from "./Computers.ts"

/** The account and Chat that own the session, and the current caller. */
export interface Owner {
	readonly identity: ExecutionIdentity
	readonly computer: string
	readonly chat?: Chat.Id
}

export class SessionGone extends Schema.TaggedError<
	SessionGone,
	{ readonly brand: unique symbol }
>()("SessionGone", { id: ComputerData.ConnectorSessionId }) {}

export const idleLimit = Duration.minutes(30)
const keepLimit = 1024 * 1024

type OnEnd = (exit: Exit, output: string) => Effect.Effect<void>
type Failure = ComputerError | SessionGone | Execution.Failure
interface Session {
	readonly id: ComputerData.ConnectorSessionId
	readonly owner: Owner
	readonly process: Process
	readonly scope: Scope.Closeable
	readonly close: Effect.Effect<void>
	readonly ended: Deferred.Deferred<Exit>
	readonly unread: Ref.Ref<Unread>
	readonly activity: Ref.Ref<{
		readonly open: boolean
		readonly touchedAt: number
	}>
	readonly onEnd: Ref.Ref<Option.Option<OnEnd>>
	readonly lock: Semaphore.Semaphore
	readonly retire: Effect.Effect<void, Execution.StorageError>
	readonly address: Resource.Address
}

interface Unread {
	readonly chunks: Chunk.Chunk<Uint8Array>
	readonly bytes: number
	/** Output was lost because nobody read it in time. */
	readonly dropped: boolean
}

const noUnread: Unread = { chunks: Chunk.empty(), bytes: 0, dropped: false }

/** Adds a chunk. Old output goes when there is too much. */
const keep = (unread: Unread, chunk: Uint8Array): Unread => {
	let chunks: Chunk.Chunk<Uint8Array> = Chunk.append(unread.chunks, chunk)
	let bytes = unread.bytes + chunk.length
	let dropped = unread.dropped
	while (bytes > keepLimit && Chunk.size(chunks) > 1) {
		bytes -= Chunk.headUnsafe(chunks).length
		chunks = Chunk.drop(chunks, 1)
		dropped = true
	}
	return { chunks, bytes, dropped }
}

const SessionCall = Schema.TaggedUnion({
	Write: { request: ComputerData.WriteStdinRequest },
	Resize: { request: ComputerData.ResizeRequest },
	Close: {},
})
type SessionCall = typeof SessionCall.Type
const Request = Schema.Struct({
	authority: Send.Authority,
	computer: Schema.String,
	chat: Schema.optionalKey(Chat.Id),
	call: SessionCall,
})
const Reply = Schema.TaggedUnion({
	Done: { output: Schema.NullOr(ComputerData.SessionOutput) },
	Gone: {},
})
const requestCodec = Schema.toCodecJson(Request)
const replyCodec = Schema.toCodecJson(Reply)
const resource = (owner: Owner, id: string): Resource.Ref => ({
	namespace: owner.identity.owner.organizationId,
	kind: "computer-session",
	id,
})
const sameOwner = (a: Owner, b: Owner) =>
	a.identity.owner.organizationId === b.identity.owner.organizationId &&
	a.identity.owner.userId === b.identity.owner.userId &&
	a.computer === b.computer &&
	a.chat === b.chat

/** One C-style escape. The capture group holds the code after the backslash. */
const escape = /\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[nrtabefv0\\])/
const simpleEscapes: Readonly<Record<string, string>> = {
	n: "\n",
	r: "\r",
	t: "\t",
	a: "\x07",
	b: "\b",
	e: "\x1b",
	f: "\f",
	v: "\v",
	"0": "\0",
	"\\": "\\",
}
const escaped = (code: string) =>
	code[0] === "x" || code[0] === "u"
		? String.fromCharCode(Number.parseInt(pipe(code, Str.slice(1)), 16))
		: (simpleEscapes[code] ?? code)

/**
 * Turns C-style escapes, such as `\x03` for Ctrl-C or `\n`, into their bytes, so a
 * model can send control keys as plain text.
 */
export const unescape = (chars: string): Uint8Array =>
	new TextEncoder().encode(
		pipe(
			// Split keeps the capture group, so the codes of the escapes are at the odd places.
			Str.split(chars, escape),
			Arr.map((part, index) => (index % 2 === 1 ? escaped(part) : part)),
			Arr.join(""),
		),
	)

/** Joins the chunks, and keeps only the end when they are longer than `max`. */
const joinTail = (chunks: ReadonlyArray<Uint8Array>, max: number) => {
	const total = Arr.reduce(chunks, 0, (sum, chunk) => sum + chunk.length)
	const all = new Uint8Array(total)
	let at = 0
	for (const chunk of chunks) {
		all.set(chunk, at)
		at += chunk.length
	}
	return total > max
		? { bytes: all.subarray(total - max), truncated: true }
		: { bytes: all, truncated: false }
}

export interface Service {
	readonly exec: (input: {
		readonly owner: Owner
		readonly machine: Machine
		readonly request: ComputerData.ExecRequest
		readonly onEnd?: OnEnd
	}) => Effect.Effect<
		| {
				session: ComputerData.ConnectorSessionId
				running: boolean
				exitCode: null
				signal: null
				output: string
				truncated: boolean
		  }
		| {
				session: null
				running: boolean
				exitCode: number | null
				signal: string | null
				output: string
				truncated: boolean
		  },
		Failure
	>
	readonly write: (
		owner: Owner,
		id: ComputerData.ConnectorSessionId,
		request: ComputerData.WriteStdinRequest,
	) => Effect.Effect<ComputerData.SessionOutput, Failure>
	readonly resize: (
		owner: Owner,
		id: ComputerData.ConnectorSessionId,
		request: ComputerData.ResizeRequest,
	) => Effect.Effect<void, Failure>
	readonly close: (
		owner: Owner,
		id: ComputerData.ConnectorSessionId,
	) => Effect.Effect<ComputerData.SessionOutput, Failure>
}

export class Sessions extends Context.Service<Sessions, Service>()(
	"@openbot-build/openbot/computers/Sessions",
) {}

export const make = Effect.gen(function* () {
	const background = yield* Background.make
	const crypto = yield* Crypto.Crypto
	const scope = yield* Scope.Scope
	const transport = yield* Transport
	const access = yield* Send.Access
	const computers = yield* Computers
	const errors = yield* Records
	const sessions = yield* Ref.make(
		HashMap.empty<ComputerData.ConnectorSessionId, Session>(),
	)
	const safe = <A, E, R>(
		work: Effect.Effect<A, E, R>,
	): Effect.Effect<A, Failure, R> =>
		work.pipe(
			Effect.catchCause((cause): Effect.Effect<never, Failure> => {
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
						Schema.is(SessionGone)(error) ||
						Schema.is(ComputerCallFailed)(error) ||
						Schema.is(ComputerGone)(error) ||
						Schema.is(Execution.Failure)(error)
					)
						return Effect.failCause(Cause.map(cause, () => error))
				}
				return errors
					.record(cause, "unavailable")
					.pipe(Effect.orDie, Effect.flatMap(Effect.fail))
			}),
		)
	const authorize = (owner: Owner, identity: ExecutionIdentity) =>
		Effect.gen(function* () {
			if (!sameOwner(owner, { ...owner, identity }))
				return yield* Execution.Forbidden.make({})
			for (const caller of executionCallers(identity))
				yield* computers.get(caller, owner.computer, "use")
			if (owner.chat !== undefined) {
				if (
					identity.botId === undefined ||
					!(yield* computers.holds(
						identity.owner.organizationId,
						identity.botId,
						owner.computer,
					))
				)
					return yield* Execution.Forbidden.make({})
			}
		})
	// Retirement cannot wait for this call: its reply still holds the transport borrow.
	const remove = (session: Session) =>
		Effect.gen(function* () {
			yield* Ref.update(session.activity, (state) => ({
				...state,
				open: false,
			}))
			yield* Ref.update(sessions, HashMap.remove(session.id))
			yield* Ref.set(session.onEnd, Option.none())
			yield* session.retire.pipe(Effect.ensuring(session.close))
		})
	const take = (session: Session, max: number) =>
		Ref.getAndSet(session.unread, noUnread).pipe(
			Effect.map((unread) => {
				const { bytes, truncated } = joinTail(
					Chunk.toReadonlyArray(unread.chunks),
					max,
				)
				return {
					output: new TextDecoder().decode(bytes),
					truncated: truncated || unread.dropped,
				}
			}),
		)
	const read = (session: Session, yieldMs: number, maxBytes: number) =>
		Effect.gen(function* () {
			const exit = yield* Deferred.await(session.ended).pipe(
				Effect.timeoutOption(yieldMs),
			)
			const now = yield* Clock.currentTimeMillis
			yield* Ref.update(session.activity, (state) => ({
				...state,
				touchedAt: now,
			}))
			const { output, truncated } = yield* take(session, maxBytes)
			if (Option.isNone(exit))
				return {
					session: session.id,
					running: true,
					exitCode: null,
					signal: null,
					output,
					truncated,
				}
			yield* remove(session).pipe(
				background.logFailure(
					"A finished command session could not leave the directory.",
				),
			)
			if (exit.value.failure !== undefined)
				return yield* Effect.fail(exit.value.failure)
			return {
				session: null,
				running: false,
				exitCode: exit.value.code,
				signal: exit.value.signal,
				output:
					exit.value.error === undefined
						? output
						: `${output}${output === "" ? "" : "\n"}[${exit.value.error}]`,
				truncated,
			}
		})
	const callLocal = (session: Session, call: SessionCall) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const open = yield* Ref.modify(session.activity, (state) =>
				state.open ? [true, { ...state, touchedAt: now }] : [false, state],
			)
			if (!open) return yield* SessionGone.make({ id: session.id })
			switch (call._tag) {
				case "Write": {
					const bytes = unescape(call.request.chars)
					if (bytes.length > 0) yield* session.process.write(bytes)
					return yield* read(
						session,
						call.request.yieldTimeMs ?? ComputerData.yieldTimeDefault,
						call.request.maxOutputBytes ?? ComputerData.maxOutputBytesDefault,
					)
				}
				case "Resize":
					yield* session.process.resize(call.request.rows, call.request.cols)
					return null
				case "Close": {
					yield* session.process.signal("SIGTERM")
					const stopped = yield* Deferred.await(session.ended).pipe(
						Effect.timeoutOption("5 seconds"),
					)
					if (Option.isNone(stopped)) yield* session.process.signal("SIGKILL")
					return yield* read(session, 2000, ComputerData.maxOutputBytesDefault)
				}
			}
		})
	const receive = (id: ComputerData.ConnectorSessionId, raw: Schema.Json) =>
		Effect.gen(function* () {
			const request = yield* Schema.decodeEffect(requestCodec)(raw)
			const found = HashMap.get(yield* Ref.get(sessions), id)
			if (Option.isNone(found)) return Reply.cases.Gone.make({})
			const session = found.value
			return yield* session.lock.withPermit(
				Effect.gen(function* () {
					if (!HashMap.has(yield* Ref.get(sessions), id))
						return Reply.cases.Gone.make({})
					if (
						request.computer !== session.owner.computer ||
						request.chat !== session.owner.chat
					)
						return Reply.cases.Gone.make({})
					const identity = yield* access.resolve(request.authority)
					if (!sameOwner(session.owner, { ...session.owner, identity }))
						return Reply.cases.Gone.make({})
					const allowed = yield* authorize(session.owner, identity).pipe(
						Effect.as(true),
						Effect.catchTags({
							ComputerNotFound: () => Effect.succeed(false),
							Forbidden: () => Effect.succeed(false),
							ExecutionForbidden: () => Effect.succeed(false),
						}),
					)
					if (!allowed) return Reply.cases.Gone.make({})
					return yield* callLocal(session, request.call).pipe(
						Send.provide(request.authority),
						Effect.catchIf(Schema.is(Execution.Failure), (failure) =>
							Effect.fail(
								Resource.Failed.make({
									resource: resource(session.owner, id),
									outcome:
										failure.category === "outcome_unknown"
											? "unknown"
											: "not_sent",
									failure,
								}),
							),
						),
						Effect.map((output) => Reply.cases.Done.make({ output })),
						Effect.catchTag("SessionGone", () =>
							Effect.succeed(Reply.cases.Gone.make({})),
						),
					)
				}),
			)
		}).pipe(Effect.flatMap(Schema.encodeEffect(replyCodec)))

	const exec = (input: {
		readonly owner: Owner
		readonly machine: Machine
		readonly request: ComputerData.ExecRequest
		readonly onEnd?: OnEnd
	}) =>
		Effect.gen(function* () {
			const { owner, machine, request, onEnd } = input
			const authority = yield* Send.authority(owner.identity)
			yield* authorize(owner, yield* access.resolve(authority))
			const processScope = yield* Scope.fork(scope)
			const closeProcess = yield* Effect.cached(
				Scope.close(processScope, EffectExit.void),
			)
			const session = yield* Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const process = yield* restore(
						machine.shell
							.start({
								command: request.command,
								tty: request.tty ?? false,
								...(request.cwd === undefined ? {} : { cwd: request.cwd }),
								...(request.env === undefined ? {} : { env: request.env }),
								...(request.rows === undefined ? {} : { rows: request.rows }),
								...(request.cols === undefined ? {} : { cols: request.cols }),
							})
							.pipe(Scope.provide(processScope)),
					)
					const id = ComputerData.ConnectorSessionId.make(
						"cse_" +
							Str.replaceAll(
								"-",
								"",
							)(yield* crypto.randomUUIDv7().pipe(Effect.orDie)),
					)
					// The registration has its own scope. Ending the process must not cancel its final RPC reply.
					const held = yield* transport
						.register(
							resource(owner, id),
							(raw) => Stream.fromEffect(receive(id, raw)),
							{ release: closeProcess },
						)
						.pipe(Scope.provide(scope))
					const session: Session = {
						id,
						owner,
						process,
						scope: processScope,
						close: closeProcess,
						retire: held.retire,
						address: held.address,
						ended: yield* Deferred.make<Exit>(),
						unread: yield* Ref.make(noUnread),
						activity: yield* Ref.make({
							open: true,
							touchedAt: yield* Clock.currentTimeMillis,
						}),
						onEnd: yield* Ref.make(Option.none<OnEnd>()),
						lock: yield* Semaphore.make(1),
					}
					yield* Ref.update(sessions, HashMap.set(id, session))
					// Output and the end signal must not wait for a read that holds the command lock.
					yield* process.output.pipe(
						Stream.runForEach((chunk) =>
							Ref.update(session.unread, (unread) => keep(unread, chunk)),
						),
						Effect.andThen(process.exit),
						Effect.flatMap((exit) => Deferred.succeed(session.ended, exit)),
						Effect.forkIn(processScope),
					)
					yield* Deferred.await(session.ended).pipe(
						Effect.raceFirst(held.lost.pipe(Effect.andThen(Effect.interrupt))),
						Effect.flatMap((exit) =>
							session.lock.withPermit(
								Effect.gen(function* () {
									const tell = yield* Ref.getAndSet(
										session.onEnd,
										Option.none(),
									)
									if (Option.isNone(tell)) return
									const { output } = yield* take(session, 4096)
									yield* remove(session).pipe(
										Effect.ensuring(tell.value(exit, output)),
									)
								}),
							),
						),
						background.logFailure("A command end notice failed."),
						Effect.forkIn(scope),
					)
					yield* held.lost.pipe(
						Effect.andThen(session.lock.withPermit(remove(session))),
						background.logFailure("A lost command session could not close."),
						Effect.forkIn(scope),
					)
					return session
				}),
			).pipe(
				Effect.onError((cause) =>
					Scope.close(processScope, EffectExit.failCause(cause)),
				),
			)
			return yield* session.lock.withPermit(
				Effect.gen(function* () {
					const result = yield* read(
						session,
						request.yieldTimeMs ?? ComputerData.yieldTimeDefault,
						request.maxOutputBytes ?? ComputerData.maxOutputBytesDefault,
					)
					if (result.running && onEnd !== undefined)
						yield* Ref.set(session.onEnd, Option.some(onEnd))
					return result
				}),
			)
		}).pipe(safe)
	// This only closes idle physical processes. Durable work belongs to the execution engine.
	yield* background.repeat(
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			for (const session of HashMap.values(yield* Ref.get(sessions))) {
				const expired = yield* Ref.modify(session.activity, (state) =>
					state.open && now - state.touchedAt > Duration.toMillis(idleLimit)
						? [true, { ...state, open: false }]
						: [false, state],
				)
				if (!expired) continue
				// Stop admission before forking cleanup. One blocked driver must not hold other sessions.
				yield* Ref.update(sessions, HashMap.remove(session.id))
				yield* transport
					.closeLocal(session.address)
					.pipe(
						Effect.andThen(remove(session)),
						background.logFailure("An idle command process could not close."),
						Effect.forkIn(scope),
					)
			}
		}),
		{
			schedule: Schedule.spaced("1 minute"),
			message: "An idle command session could not close.",
		},
	)

	const route = (
		owner: Owner,
		id: ComputerData.ConnectorSessionId,
		call: SessionCall,
	) =>
		Effect.gen(function* () {
			const request = yield* Schema.encodeEffect(requestCodec)({
				authority: yield* Send.authority(owner.identity),
				computer: owner.computer,
				...(owner.chat === undefined ? {} : { chat: owner.chat }),
				call,
			})
			const outputs = yield* transport.call(resource(owner, id), request).pipe(
				Stream.runCollect,
				Effect.catchTags({
					ResourceGone: () => Effect.fail(SessionGone.make({ id })),
					ResourceFailed: (error) =>
						Effect.fail({
							...error.failure,
							category:
								error.outcome === "unknown"
									? ("outcome_unknown" as const)
									: error.failure.category,
						}),
				}),
			)
			const raw = yield* Effect.fromOption(Arr.head(outputs))
			const reply = yield* Schema.decodeEffect(replyCodec)(raw)
			if (reply._tag === "Gone") return yield* SessionGone.make({ id })
			return reply.output
		}).pipe(safe)
	const output = (id: ComputerData.ConnectorSessionId) =>
		Effect.flatMap((result: ComputerData.SessionOutput | null) =>
			result === null
				? Effect.fail(SessionGone.make({ id }))
				: Effect.succeed(result),
		)
	return Sessions.of({
		exec,
		write: (
			owner: Owner,
			id: ComputerData.ConnectorSessionId,
			request: ComputerData.WriteStdinRequest,
		) => route(owner, id, { _tag: "Write", request }).pipe(output(id)),
		resize: (
			owner: Owner,
			id: ComputerData.ConnectorSessionId,
			request: ComputerData.ResizeRequest,
		) => route(owner, id, { _tag: "Resize", request }).pipe(Effect.asVoid),
		close: (owner: Owner, id: ComputerData.ConnectorSessionId) =>
			route(owner, id, { _tag: "Close" }).pipe(output(id)),
	})
})

export const layer = Layer.effect(Sessions, make)
