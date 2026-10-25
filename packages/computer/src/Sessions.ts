// These functions take all their inputs at once. A pipeable form does not help here.
// @effect-diagnostics missingPipeableSignature:off
import { spawn } from "node:child_process"
import { constants } from "node:os"
import { resolve } from "node:path"
import type { ComputersApi } from "@openbot-build/api"
import {
	Effect,
	FileSystem,
	HashMap,
	Option,
	Queue,
	Ref,
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
}

export const defaultFrame = 64 * 1024

/** One running command. Each function does nothing after the command has stopped. */
interface Process {
	readonly write: (bytes: Buffer) => void
	readonly resize: (rows: number, cols: number) => void
	readonly signal: (signal: NodeJS.Signals) => void
}

interface Sink {
	readonly output: (bytes: Buffer) => void
	readonly exit: (
		code: number | null,
		signal: string | null,
		error?: string,
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

const signalName = (signal: number | undefined): string | null => {
	if (signal === undefined || signal === 0) return null
	const entry = Object.entries(constants.signals).find(
		([, value]) => value === signal,
	)
	return entry === undefined ? String(signal) : entry[0]
}

/** The byte Ctrl-D. Without a terminal, it closes stdin. */
const endOfInput = 0x04

/**
 * Runs a command with stdin, stdout, and stderr as pipes. The command gets its own
 * process group. stdout and stderr go to the same output.
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
	child.on("error", (error) => {
		if (finished) return
		finished = true
		sink.exit(null, null, error.message)
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
	}
}

/**
 * Runs a command on a new terminal (a PTY). The terminal makes a new process group
 * for the command. stdout and stderr both go to the terminal.
 */
const spawnTerminal = Effect.fnUntraced(function* (
	start: Start,
	cwd: string,
	sink: Sink,
) {
	// The native module loads only when a session needs a terminal.
	const pty = yield* Effect.promise(() => import("@lydell/node-pty"))
	let finished = false
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
	} satisfies Process
})

/** Checks the folder first, because Node gives the unclear error "spawn bash ENOENT" for a missing folder. */
const folderOf = (fs: FileSystem.FileSystem, folder: string) =>
	fs.stat(folder).pipe(
		Effect.option,
		Effect.map((info) =>
			Option.isNone(info)
				? Option.some(`The folder ${folder} does not exist.`)
				: info.value.type !== "Directory"
					? Option.some(`${folder} is not a folder.`)
					: Option.none(),
		),
	)

export interface Sessions {
	/** Does one session message. It returns when the message is done, and never fails. */
	readonly handle: (message: SessionMessage) => Effect.Effect<void>
}

/**
 * Keeps the command sessions of one connection. `send` gets each `Output` and `Exit`
 * in order. When the scope closes, all the sessions stop.
 */
export const make = <E>(
	options: Options,
	send: (message: Outgoing) => Effect.Effect<void, E>,
): Effect.Effect<Sessions, never, Scope.Scope | FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const running = yield* Ref.make(HashMap.empty<string, Process>())
		// Node gives output in callbacks. The callbacks put messages in this queue,
		// and one fiber sends them in order.
		const outbox = yield* Queue.unbounded<Outgoing>()

		yield* Queue.take(outbox).pipe(
			Effect.tap((message) =>
				message._tag === "Exit"
					? Ref.update(running, HashMap.remove(message.session))
					: Effect.void,
			),
			Effect.flatMap(send),
			Effect.forever,
			Effect.forkScoped,
		)
		yield* Effect.addFinalizer(() =>
			Ref.get(running).pipe(
				Effect.map((all) => {
					for (const session of HashMap.values(all)) session.signal("SIGKILL")
				}),
			),
		)

		const sinkFor = (session: string): Sink => {
			let seq = 0
			return {
				output: (bytes) => {
					for (let at = 0; at < bytes.length; at += options.maxFrame)
						Queue.offerUnsafe(outbox, {
							_tag: "Output",
							session,
							seq: seq++,
							data: bytes
								.subarray(at, at + options.maxFrame)
								.toString("base64"),
						})
				},
				exit: (code, signal, error) => {
					Queue.offerUnsafe(outbox, {
						_tag: "Exit",
						session,
						code,
						signal,
						...(error === undefined ? {} : { error }),
					})
				},
			}
		}

		const start = Effect.fnUntraced(function* (message: Start) {
			const sink = sinkFor(message.session)
			const cwd = resolve(options.home, message.cwd ?? ".")
			const problem = yield* folderOf(fs, cwd)
			if (Option.isSome(problem)) return sink.exit(null, null, problem.value)
			const child = message.tty
				? yield* spawnTerminal(message, cwd, sink)
				: spawnPipes(message, cwd, sink)
			yield* Ref.update(running, HashMap.set(message.session, child))
		})

		const withSession = (session: string, use: (child: Process) => void) =>
			Ref.get(running).pipe(
				Effect.map((all) => Option.map(HashMap.get(all, session), use)),
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
										Effect.catchDefect((defect) =>
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
