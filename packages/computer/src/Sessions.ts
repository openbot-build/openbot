// @effect-diagnostics-next-line nodeBuiltinImport:off -- The Effect ChildProcess handle does not say which signal stopped a command, and its kill waits for the end. Exit needs the signal name, and Signal must not wait.
import { spawn } from "node:child_process"
import { constants } from "node:os"
import type * as NodePty from "@lydell/node-pty"
import type { ComputersApi } from "@openbot-build/api"
import {
	Array as Arr,
	Cause,
	Effect,
	FileSystem,
	HashMap,
	Latch,
	Option,
	Path,
	pipe,
	Queue,
	Record as Rec,
	Ref,
	Schema,
	type Scope,
} from "effect"

/** The messages from OpenBot that are about command sessions. */
export type SessionMessage = Extract<
	ComputersApi.ToConnector,
	{ readonly _tag: "Start" | "Input" | "Resize" | "Signal" | "Close" }
>

type Start = Extract<SessionMessage, { readonly _tag: "Start" }>
type Outgoing = Extract<
	ComputersApi.FromConnector,
	{ readonly _tag: "Output" | "Exit" }
>

export interface Options {
	/** Where commands run when the session gives no folder. */
	readonly home: string
	/** The most bytes of output in one `Output` message. */
	readonly maxFrame: number
	/**
	 * The most bytes of output that wait to be sent. Above it, all commands pause.
	 * They go on when half of it has been sent.
	 */
	readonly highWaterMark: number
}

export const defaultFrame = 64 * 1024

export const defaultHighWaterMark = 1024 * 1024

/** A command could not start. Its message goes to OpenBot in the `Exit`. */
class StartFailed extends Schema.TaggedError<
	StartFailed,
	{ readonly brand: unique symbol }
>()("StartFailed", { message: Schema.String, cause: Schema.Defect() }) {}

/** One running command. Each function does nothing after the command has stopped. */
interface Process {
	readonly write: (bytes: Buffer) => void
	readonly resize: (rows: number, cols: number) => void
	readonly signal: (signal: NodeJS.Signals) => void
	/** Stops reading the output. When the buffers are full, the command waits. */
	readonly pause: () => void
	readonly resume: () => void
	/** Reads the output of a paused command again when the command has ended. */
	readonly drainIfEnded: () => void
}

interface Sink {
	readonly output: (bytes: Buffer) => void
	/** `cause` is the failure that stopped the start of the command. It goes only to the log. */
	readonly exit: (
		code: number | null,
		signal: string | null,
		error?: string,
		cause?: unknown,
	) => void
}

/** Sends a signal to the full process group, so the children of the command get it too. */
const signalGroup = (pid: number | undefined, signal: NodeJS.Signals) => {
	if (pid === undefined) return
	try {
		process.kill(-pid, signal)
	} catch {
		// The process group is already gone.
	}
}

/** True while the process is there. Signal 0 only checks this. */
const exists = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

const signalName = (signal: number | undefined): string | null => {
	if (signal === undefined || signal === 0) return null
	return pipe(
		Rec.toEntries(constants.signals),
		Arr.findFirst(([, value]) => value === signal),
		Option.match({ onNone: () => String(signal), onSome: ([name]) => name }),
	)
}

/** The byte Ctrl-D. Without a terminal, it closes stdin. */
const endOfInput = 0x04

/**
 * Runs a command with stdin, stdout, and stderr as pipes. The command gets its own
 * process group. stdout and stderr go to the same output. It throws when Node does
 * not take the options, for example an `env` value with a NUL byte.
 */
const spawnPipes = (start: Start, cwd: string, sink: Sink): Process => {
	let finished = false
	const child = spawn("bash", ["-lc", start.command], {
		cwd,
		env: { ...process.env, ...start.env },
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
	})
	child.stdout.on("data", sink.output)
	child.stderr.on("data", sink.output)
	// The command can stop before it reads all its input. Then a write gives EPIPE.
	child.stdin.on("error", () => {})
	// Node gives most spawn failures here, such as ENOENT or EAGAIN, and does not throw them.
	child.on("error", (error) => {
		if (finished) return
		finished = true
		sink.exit(null, null, error.message, error)
	})
	// "close" comes after stdout and stderr have ended, so no output comes after `Exit`.
	child.on("close", (code, signal) => {
		if (finished) return
		finished = true
		sink.exit(code, signal)
	})
	return {
		write: (bytes) => {
			if (finished || !child.stdin.writable) return
			const end = bytes.indexOf(endOfInput)
			if (end === -1) child.stdin.write(bytes)
			else child.stdin.end(bytes.subarray(0, end))
		},
		resize: () => {},
		signal: (signal) => {
			if (!finished) signalGroup(child.pid, signal)
		},
		pause: () => {
			if (finished) return
			child.stdout.pause()
			child.stderr.pause()
		},
		resume: () => {
			if (finished) return
			child.stdout.resume()
			child.stderr.resume()
		},
		// A paused pipe keeps its output, and "close" waits for it.
		drainIfEnded: () => {},
	}
}

/** The native module loads only when a session needs a terminal. */
const loadTerminal = Effect.tryPromise({
	try: () => import("@lydell/node-pty"),
	catch: (cause) =>
		StartFailed.make({
			message: "The terminal module does not load on this machine.",
			cause,
		}),
})

/**
 * Runs a command on a new terminal (a PTY). The terminal makes a new process group
 * for the command. stdout and stderr both go to the terminal. It throws when the
 * terminal does not start.
 */
const spawnTerminal = (
	pty: typeof NodePty,
	start: Start,
	cwd: string,
	sink: Sink,
): Process => {
	let finished = false
	// True when the command has ended while the terminal was paused.
	let ended = false
	const terminal = pty.spawn("bash", ["-lc", start.command], {
		name: "xterm-256color",
		cwd,
		env: { ...process.env, ...start.env },
		rows: start.rows ?? 24,
		cols: start.cols ?? 80,
		// With no encoding, the data comes as a Buffer. The type says string, but it is a Buffer.
		encoding: null,
	})
	terminal.onData((data) => sink.output(Buffer.from(data)))
	terminal.onExit(({ exitCode, signal }) => {
		finished = true
		const name = signalName(signal)
		sink.exit(name === null ? exitCode : null, name)
	})
	return {
		write: (bytes) => {
			if (!finished) terminal.write(bytes)
		},
		resize: (rows, cols) => {
			if (!finished) terminal.resize(cols, rows)
		},
		signal: (signal) => {
			if (!finished) signalGroup(terminal.pid, signal)
		},
		pause: () => {
			if (!finished && !ended) terminal.pause()
		},
		resume: () => {
			if (!finished) terminal.resume()
		},
		// node-pty waits only 200 ms for the last output after the command ends. Then it
		// closes the terminal, and the output that nobody has read is lost. So an ended
		// command reads again at once, and it does not pause again.
		drainIfEnded: () => {
			if (finished || ended || exists(terminal.pid)) return
			ended = true
			terminal.resume()
		},
	}
}

/** Checks the folder first, because Node gives the unclear error "spawn bash ENOENT" for a missing folder. */
const folderOf = (
	fs: FileSystem.FileSystem,
	folder: string,
): Effect.Effect<Option.Option<string>> =>
	fs.stat(folder).pipe(
		Effect.map((info) =>
			info.type !== "Directory"
				? Option.some(`${folder} is not a folder.`)
				: Option.none<string>(),
		),
		Effect.catchIf(
			(error) => error.reason._tag === "NotFound",
			() => Effect.succeedSome(`The folder ${folder} does not exist.`),
		),
		Effect.catch((error) =>
			Effect.succeedSome(
				`Could not open the folder ${folder}: ${error.message}`,
			),
		),
	)

export interface Sessions {
	/** Does one session message. It returns when the message is done, and never fails. */
	readonly handle: (message: SessionMessage) => Effect.Effect<void>
}

/**
 * Keeps the command sessions of one connection. `send` gets each `Output` and `Exit`
 * in order. When `send` is slow, the commands pause. When the scope closes, all the
 * sessions stop.
 */
export const make = <E>(
	options: Options,
	send: (message: Outgoing) => Effect.Effect<void, E>,
): Effect.Effect<
	Sessions,
	never,
	Scope.Scope | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const running = yield* Ref.make(
			HashMap.empty<ComputersApi.ConnectorSessionId, Process>(),
		)
		// Node gives output in callbacks. The callbacks put messages in this queue,
		// and one fiber sends them in order. The queue has no fixed size, because an
		// `Exit` must always go in. The commands pause in its place.
		const outbox = yield* Queue.unbounded<{
			readonly message: Outgoing
			readonly bytes: number
			/** Why the command of an `Exit` could not start. */
			readonly cause?: unknown
		}>()
		// The bytes of output in the outbox.
		let queued = 0
		// It is open while the commands are paused.
		const paused = yield* Latch.make(false)
		const eachRunning = (use: (child: Process) => void) =>
			HashMap.forEach(Ref.getUnsafe(running), use)

		yield* Queue.take(outbox).pipe(
			Effect.tap(({ message, bytes }) =>
				Effect.sync(() => {
					queued -= bytes
					if (queued <= options.highWaterMark / 2 && Latch.closeUnsafe(paused))
						eachRunning((child) => child.resume())
				}).pipe(
					Effect.andThen(
						message._tag === "Exit"
							? Ref.update(running, HashMap.remove(message.session))
							: Effect.void,
					),
				),
			),
			Effect.tap(({ message, cause }) =>
				cause === undefined
					? Effect.void
					: Effect.logWarning(
							"A command session could not start.",
							Cause.fail(cause),
						).pipe(Effect.annotateLogs({ session: message.session })),
			),
			Effect.flatMap(({ message }) => send(message)),
			Effect.forever,
			Effect.tapCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.void
					: Effect.logWarning("Could not send session output.", cause),
			),
			Effect.forkScoped,
		)
		// See `drainIfEnded`: while the commands are paused, look often for ended ones.
		yield* Latch.await(paused).pipe(
			Effect.andThen(Effect.sleep("50 millis")),
			Effect.andThen(
				Effect.sync(() => eachRunning((child) => child.drainIfEnded())),
			),
			Effect.forever,
			Effect.forkScoped,
		)
		yield* Effect.addFinalizer(() =>
			Ref.get(running).pipe(
				Effect.flatMap((all) =>
					Effect.forEach(
						HashMap.values(all),
						(child) => Effect.sync(() => child.signal("SIGKILL")),
						{ discard: true },
					),
				),
				// Nobody reads the output that comes after this.
				Effect.andThen(Queue.shutdown(outbox)),
			),
		)

		const sinkFor = (session: ComputersApi.ConnectorSessionId): Sink => {
			let seq = 0
			return {
				output: (bytes) => {
					for (let at = 0; at < bytes.length; at += options.maxFrame) {
						const frame = bytes.subarray(at, at + options.maxFrame)
						// After the scope closes, the outbox takes nothing, and no fiber makes
						// `queued` smaller. Output that is not counted cannot pause the commands.
						if (
							!Queue.offerUnsafe(outbox, {
								message: {
									_tag: "Output",
									session,
									seq: seq++,
									data: frame.toString("base64"),
								},
								bytes: frame.length,
							})
						)
							return
						queued += frame.length
					}
					if (queued > options.highWaterMark && Latch.openUnsafe(paused))
						eachRunning((child) => child.pause())
				},
				exit: (code, signal, error, cause) => {
					Queue.offerUnsafe(outbox, {
						message: {
							_tag: "Exit",
							session,
							code,
							signal,
							...(error === undefined ? {} : { error }),
						},
						bytes: 0,
						...(cause === undefined ? {} : { cause }),
					})
				},
			}
		}

		const start = Effect.fnUntraced(function* (message: Start) {
			const sink = sinkFor(message.session)
			const cwd = path.resolve(options.home, message.cwd ?? ".")
			const problem = yield* folderOf(fs, cwd)
			if (Option.isSome(problem)) return sink.exit(null, null, problem.value)
			const pty = message.tty
				? Option.some(yield* loadTerminal)
				: Option.none<typeof NodePty>()
			// The command goes into `running` in the same step that starts it, so the
			// finalizer always stops it.
			yield* Effect.try({
				try: () =>
					Option.match(pty, {
						onNone: () => spawnPipes(message, cwd, sink),
						onSome: (pty) => spawnTerminal(pty, message, cwd, sink),
					}),
				catch: (cause) =>
					StartFailed.make({
						message: `The command could not start: ${cause instanceof Error ? cause.message : String(cause)}`,
						cause,
					}),
			}).pipe(
				Effect.flatMap((child) =>
					Ref.update(running, HashMap.set(message.session, child)).pipe(
						Effect.andThen(
							Effect.sync(() => {
								if (Latch.isOpen(paused)) child.pause()
							}),
						),
					),
				),
				Effect.uninterruptible,
			)
		})

		const withSession = (
			session: ComputersApi.ConnectorSessionId,
			use: (child: Process) => void,
		): Effect.Effect<void> =>
			Ref.get(running).pipe(
				Effect.flatMap((all) =>
					Option.match(HashMap.get(all, session), {
						onNone: () => Effect.void,
						onSome: (child) => Effect.sync(() => use(child)),
					}),
				),
			)

		const handle = (message: SessionMessage): Effect.Effect<void> => {
			switch (message._tag) {
				case "Start":
					return Ref.get(running).pipe(
						Effect.flatMap((all) =>
							HashMap.has(all, message.session)
								? Effect.logWarning(
										`OpenBot started the session ${message.session} again. The connector keeps the first one.`,
									)
								: start(message).pipe(
										Effect.catchTag("StartFailed", (error) =>
											Effect.logWarning(
												"A command session could not start.",
												Cause.fail(error),
											).pipe(
												Effect.andThen(
													Effect.sync(() =>
														sinkFor(message.session).exit(
															null,
															null,
															error.message,
														),
													),
												),
											),
										),
										// A defect is a bug in the connector. OpenBot still gets an `Exit`.
										Effect.catchDefect((defect) =>
											Effect.logError(
												"A command session could not start.",
												Cause.die(defect),
											).pipe(
												Effect.andThen(
													Effect.sync(() =>
														sinkFor(message.session).exit(
															null,
															null,
															defect instanceof Error
																? defect.message
																: String(defect),
														),
													),
												),
											),
										),
										Effect.annotateLogs({ session: message.session }),
									),
						),
					)
				case "Input":
					return withSession(message.session, (child) =>
						child.write(Buffer.from(message.data, "base64")),
					)
				case "Resize":
					return withSession(message.session, (child) =>
						child.resize(message.rows, message.cols),
					)
				case "Signal":
					return withSession(message.session, (child) =>
						child.signal(message.signal),
					)
				case "Close":
					return withSession(message.session, (child) =>
						child.signal("SIGKILL"),
					)
			}
		}

		return { handle }
	})
