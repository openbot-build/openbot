import { randomUUID } from "node:crypto"
import { ComputersApi } from "@openbot-build/api"
import type { Chat } from "@openbot-build/core"
import { PgClient } from "@effect/sql-pg"
import { eq } from "drizzle-orm"
import {
	Chunk,
	Clock,
	Context,
	Deferred,
	Duration,
	Effect,
	Exit as EffectExit,
	HashMap,
	Layer,
	Option,
	PubSub,
	Queue,
	Ref,
	Schedule,
	Schema,
	Scope,
	Stream,
} from "effect"
import * as Db from "../database/Database.ts"
import { computerCalls } from "../database/Schema.ts"
import {
	ComputerCallFailed,
	type ComputerError,
	type Exit,
	type Machine,
	type Process,
} from "./Computer.ts"

/** Who a session belongs to. Only the same owner, in the same Chat, may use it. */
export interface Owner {
	/** Such as the owner key of a member. */
	readonly key: string
	readonly chat?: Chat.Id
}

/** The session is not there. It ended, or another owner has it. */
export class SessionGone extends Schema.TaggedError<SessionGone>()(
	"SessionGone",
	{
		id: Schema.String,
	},
) {}

/** A session ends when nobody reads it or writes to it for this long. */
export const idleLimit = Duration.minutes(30)
/** The most output that a session keeps between two reads, in bytes. */
const keepLimit = 1024 * 1024
/** Instances send calls for sessions on other instances on this channel. */
export const channel = "openbot_computer_sessions_calls"

interface Session {
	readonly id: string
	readonly owner: Owner
	readonly process: Process
	readonly scope: Scope.Closeable
	/** It is done when the command ends and all its output is here. */
	readonly ended: Deferred.Deferred<Exit>
	/** The output that nobody has read yet. */
	readonly unread: Ref.Ref<Unread>
	readonly touchedAt: Ref.Ref<number>
	/** Who to tell at the end. It is taken once, by the first that sees the end. */
	readonly onEnd: Ref.Ref<Option.Option<OnEnd>>
}

type OnEnd = (exit: Exit, output: string) => Effect.Effect<void>

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

/** The call of another instance for a session on this instance. */
const SessionCall = Schema.TaggedUnion({
	Write: { request: ComputersApi.WriteStdinRequest },
	Resize: { request: ComputersApi.ResizeRequest },
	Close: {},
})
type SessionCall = typeof SessionCall.Type
const CallRow = Schema.Struct({
	session: Schema.String,
	owner: Schema.Struct({
		key: Schema.String,
		chat: Schema.optionalKey(Schema.String),
	}),
	call: SessionCall,
})
const CallReply = Schema.TaggedUnion({
	Done: { output: Schema.NullOr(ComputersApi.SessionOutput) },
	Gone: {},
	Failed: { message: Schema.String },
})
const encodeRow = Schema.encodeSync(Schema.fromJsonString(CallRow))
const decodeRow = Schema.decodeUnknownOption(Schema.fromJsonString(CallRow))
const encodeReply = Schema.encodeSync(Schema.fromJsonString(CallReply))
const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(CallReply))

/**
 * Turns C-style escapes, such as `\x03` for Ctrl-C or `\n`, into their bytes, so a
 * model can send control keys as plain text.
 */
export const unescape = (chars: string): Uint8Array => {
	const text = chars.replace(
		/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[nrtabefv0\\])/g,
		(_, code: string) => {
			if (code[0] === "x" || code[0] === "u")
				return String.fromCharCode(Number.parseInt(code.slice(1), 16))
			const simple: Record<string, string> = {
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
			return simple[code] ?? code
		},
	)
	return new TextEncoder().encode(text)
}

/** Joins the chunks, and keeps only the end when they are longer than `max`. */
const joinTail = (chunks: ReadonlyArray<Uint8Array>, max: number) => {
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
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

const sameOwner = (a: Owner, b: Owner) => a.key === b.key && a.chat === b.chat

export class Sessions extends Context.Service<
	Sessions,
	{
		/**
		 * Starts a command and waits up to its yield time. When it still runs, the
		 * output has a session ID. `onEnd` runs when such a command ends, unless a read
		 * already gave its end.
		 */
		readonly exec: (input: {
			readonly owner: Owner
			readonly machine: Machine
			readonly request: ComputersApi.ExecRequest
			readonly onEnd?: (exit: Exit, output: string) => Effect.Effect<void>
		}) => Effect.Effect<ComputersApi.SessionOutput, ComputerError>
		readonly write: (
			owner: Owner,
			id: string,
			request: ComputersApi.WriteStdinRequest,
		) => Effect.Effect<ComputersApi.SessionOutput, ComputerError | SessionGone>
		readonly resize: (
			owner: Owner,
			id: string,
			request: ComputersApi.ResizeRequest,
		) => Effect.Effect<void, ComputerError | SessionGone>
		readonly close: (
			owner: Owner,
			id: string,
		) => Effect.Effect<ComputersApi.SessionOutput, ComputerError | SessionGone>
	}
>()("@openbot-build/openbot/computers/Sessions") {}

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const client = yield* PgClient.PgClient
	const scope = yield* Scope.Scope
	const sessions = yield* Ref.make(HashMap.empty<string, Session>())
	const replies = yield* PubSub.unbounded<string>()
	yield* Effect.addFinalizer(() => PubSub.shutdown(replies))

	const remove = (session: Session) =>
		Ref.update(sessions, HashMap.remove(session.id)).pipe(
			Effect.andThen(Ref.set(session.onEnd, Option.none())),
			Effect.andThen(Scope.close(session.scope, EffectExit.void)),
		)

	/** Takes the output since the last read. */
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

	/** Waits for the end or the yield time, then gives the new output. */
	const read = (
		session: Session,
		yieldMs: number,
		maxBytes: number,
	): Effect.Effect<ComputersApi.SessionOutput> =>
		Effect.gen(function* () {
			const exit = yield* Deferred.await(session.ended).pipe(
				Effect.timeoutOption(yieldMs),
			)
			yield* Ref.set(session.touchedAt, yield* Clock.currentTimeMillis)
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
			// The caller sees the end now, so nobody needs to be told later.
			yield* remove(session)
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

	const exec: (typeof Sessions.Service)["exec"] = ({
		owner,
		machine,
		request,
		onEnd,
	}) =>
		Effect.gen(function* () {
			const sessionScope = yield* Scope.fork(scope)
			const process = yield* machine.shell
				.start({
					command: request.command,
					tty: request.tty ?? false,
					...(request.cwd === undefined ? {} : { cwd: request.cwd }),
					...(request.env === undefined ? {} : { env: request.env }),
					...(request.rows === undefined ? {} : { rows: request.rows }),
					...(request.cols === undefined ? {} : { cols: request.cols }),
				})
				.pipe(
					Scope.provide(sessionScope),
					Effect.onError((cause) =>
						Scope.close(sessionScope, EffectExit.failCause(cause)),
					),
				)
			const session: Session = {
				id: "cse_" + randomUUID().replaceAll("-", ""),
				owner,
				process,
				scope: sessionScope,
				ended: yield* Deferred.make<Exit>(),
				unread: yield* Ref.make(noUnread),
				touchedAt: yield* Ref.make(yield* Clock.currentTimeMillis),
				onEnd: yield* Ref.make(Option.fromNullishOr(onEnd)),
			}
			yield* Ref.update(sessions, HashMap.set(session.id, session))
			// Keeps the output until the next read.
			yield* process.output.pipe(
				Stream.runForEach((chunk) =>
					Ref.update(session.unread, (unread) => keep(unread, chunk)),
				),
				Effect.andThen(process.exit),
				Effect.flatMap((exit) =>
					Effect.gen(function* () {
						yield* Deferred.succeed(session.ended, exit)
						const tell = yield* Ref.getAndSet(session.onEnd, Option.none())
						if (Option.isNone(tell)) return
						const { output } = yield* take(session, 4096)
						yield* remove(session)
						yield* tell.value(exit, output)
					}),
				),
				Effect.forkIn(sessionScope),
			)
			// A session that nobody uses ends, so it does not run for ever.
			yield* Effect.gen(function* () {
				while (true) {
					yield* Effect.sleep(Duration.minutes(1))
					const now = yield* Clock.currentTimeMillis
					const touchedAt = yield* Ref.get(session.touchedAt)
					if (now - touchedAt > Duration.toMillis(idleLimit)) {
						yield* process.signal("SIGKILL").pipe(Effect.ignore)
						yield* remove(session)
						return
					}
				}
			}).pipe(Effect.forkIn(sessionScope))
			return yield* read(
				session,
				request.yieldTimeMs ?? ComputersApi.yieldTimeDefault,
				request.maxOutputBytes ?? ComputersApi.maxOutputBytesDefault,
			)
		})

	/** The session on this instance, when the owner may use it. */
	const own = (owner: Owner, id: string) =>
		Ref.get(sessions).pipe(
			Effect.map((all) =>
				HashMap.get(all, id).pipe(
					Option.filter((session) => sameOwner(session.owner, owner)),
				),
			),
		)

	/** Does a call on a session of this instance. */
	const callLocal = (
		session: Session,
		call: SessionCall,
	): Effect.Effect<ComputersApi.SessionOutput | null, ComputerError> =>
		Effect.gen(function* () {
			yield* Ref.set(session.touchedAt, yield* Clock.currentTimeMillis)
			switch (call._tag) {
				case "Write": {
					const bytes = unescape(call.request.chars)
					if (bytes.length > 0) yield* session.process.write(bytes)
					return yield* read(
						session,
						call.request.yieldTimeMs ?? ComputersApi.yieldTimeDefault,
						call.request.maxOutputBytes ?? ComputersApi.maxOutputBytesDefault,
					)
				}
				case "Resize":
					yield* session.process.resize(call.request.rows, call.request.cols)
					return null
				case "Close": {
					yield* session.process.signal("SIGTERM").pipe(Effect.ignore)
					const stopped = yield* Deferred.await(session.ended).pipe(
						Effect.timeoutOption("5 seconds"),
					)
					if (Option.isNone(stopped))
						yield* session.process.signal("SIGKILL").pipe(Effect.ignore)
					return yield* read(session, 2000, ComputersApi.maxOutputBytesDefault)
				}
			}
		})

	/** Sends a call to the instance with the session, and waits for its reply. */
	const callRemote = (
		owner: Owner,
		id: string,
		call: SessionCall,
		wait: Duration.Input,
	) =>
		Effect.scoped(
			Effect.gen(function* () {
				const subscription = yield* PubSub.subscribe(replies)
				const callId = randomUUID()
				const now = yield* Clock.currentTimeMillis
				yield* db
					.insert(computerCalls)
					.values({
						id: callId,
						computerId: `session:${id}`,
						call: encodeRow({ session: id, owner, call }),
						createdAt: now,
					})
					.pipe(Effect.orDie)
				yield* client.notify(channel, `call:${callId}`).pipe(Effect.ignore)
				const replied = yield* Stream.fromSubscription(subscription).pipe(
					Stream.filter((each) => each === callId),
					Stream.runHead,
					Effect.timeoutOption(wait),
				)
				const row = (yield* db
					.select()
					.from(computerCalls)
					.where(eq(computerCalls.id, callId))
					.pipe(Effect.orElseSucceed(() => [])))[0]
				yield* db
					.delete(computerCalls)
					.where(eq(computerCalls.id, callId))
					.pipe(Effect.ignore)
				const reply =
					Option.isNone(replied) || row?.reply == null
						? Option.none()
						: decodeReply(row.reply)
				if (Option.isNone(reply) || reply.value._tag === "Gone")
					return yield* SessionGone.make({ id })
				if (reply.value._tag === "Failed")
					return yield* ComputerCallFailed.make({
						message: reply.value.message,
						retry: false,
					})
				return reply.value.output
			}),
		)

	/** Another instance asked for a call. Do it when the session is here. */
	const onCall = (callId: string) =>
		Effect.gen(function* () {
			const row = (yield* db
				.select()
				.from(computerCalls)
				.where(eq(computerCalls.id, callId))
				.pipe(Effect.orElseSucceed(() => [])))[0]
			if (row === undefined || row.reply !== null) return
			const parsed = decodeRow(row.call)
			if (Option.isNone(parsed)) return
			const { session: id, owner, call } = parsed.value
			const found = HashMap.get(yield* Ref.get(sessions), id)
			if (Option.isNone(found)) return
			const session = found.value
			const reply: typeof CallReply.Type = !sameOwner(
				session.owner,
				owner as Owner,
			)
				? { _tag: "Gone" }
				: yield* callLocal(session, call).pipe(
						Effect.map((output) => ({ _tag: "Done" as const, output })),
						Effect.catch((error) =>
							Effect.succeed({
								_tag: "Failed" as const,
								message:
									error._tag === "ComputerGone" ? error.reason : error.message,
							}),
						),
					)
			yield* db
				.update(computerCalls)
				.set({ reply: encodeReply(reply) })
				.where(eq(computerCalls.id, callId))
				.pipe(Effect.ignore)
			yield* client.notify(channel, `reply:${callId}`).pipe(Effect.ignore)
		})

	yield* Effect.scoped(
		Effect.gen(function* () {
			const notices = yield* client.listen(channel)
			while (true) {
				const { payload } = yield* Queue.take(notices)
				const [kind, id = ""] = payload.split(":")
				if (kind === "call") yield* Effect.forkIn(onCall(id), scope)
				else if (kind === "reply") yield* PubSub.publish(replies, id)
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

	/** Does a call where the session is: here, or on another instance. */
	const route = (
		owner: Owner,
		id: string,
		call: SessionCall,
		wait: Duration.Input,
	): Effect.Effect<
		ComputersApi.SessionOutput | null,
		ComputerError | SessionGone
	> =>
		Effect.gen(function* () {
			const session = yield* own(owner, id)
			if (Option.isSome(session)) return yield* callLocal(session.value, call)
			if (HashMap.has(yield* Ref.get(sessions), id))
				return yield* SessionGone.make({ id })
			return yield* callRemote(owner, id, call, wait)
		})
	const yieldOf = (request: { readonly yieldTimeMs?: number }) =>
		Duration.millis(
			(request.yieldTimeMs ?? ComputersApi.yieldTimeDefault) + 10_000,
		)

	return Sessions.of({
		exec,
		write: (owner, id, request) =>
			route(owner, id, { _tag: "Write", request }, yieldOf(request)).pipe(
				Effect.filterOrFail(
					(output): output is ComputersApi.SessionOutput => output !== null,
					() => SessionGone.make({ id }),
				),
			),
		resize: (owner, id, request) =>
			route(owner, id, { _tag: "Resize", request }, "10 seconds").pipe(
				Effect.asVoid,
			),
		close: (owner, id) =>
			route(owner, id, { _tag: "Close" }, "20 seconds").pipe(
				Effect.filterOrFail(
					(output): output is ComputersApi.SessionOutput => output !== null,
					() => SessionGone.make({ id }),
				),
			),
	})
})

export const layer = Layer.effect(Sessions, make)
