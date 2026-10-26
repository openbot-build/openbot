import type { ComputersApi } from "@openbot-build/api"
import {
	Array as Arr,
	Deferred,
	Effect,
	Option,
	Record as Rec,
	Ref,
	Result,
	Schema,
	type Scope,
	Stream,
	String as Str,
} from "effect"
import { Base64 } from "effect/encoding"
import { type HttpClient, HttpClientRequest } from "effect/http"
import * as Background from "../../app/Background.ts"
import {
	ComputerCallFailed,
	type RunRequest,
	type RunResult,
	type Process,
	type StartRequest,
} from "../Computer.ts"
import * as ProcessSink from "../Process.ts"
import {
	appendTail,
	emptyTail,
	failed,
	field,
	json,
	number,
	ok,
	outputLimit,
	parseJson,
	type Reply,
	send,
	string,
	type Tail,
	tailText,
	unreachable,
} from "../Http.ts"

/**
 * envd is the small server inside each E2B sandbox. It serves files over plain HTTP
 * and processes and folders over the Connect protocol, a simple form of gRPC over HTTP.
 * See `spec/envd` in https://github.com/e2b-dev/E2B.
 */
export interface Connection {
	readonly sandboxId: string
	/** Such as `https://49983-<sandbox ID>.e2b.app`. */
	readonly url: string
	readonly accessToken: string | undefined
}

export const envdPort = 49983

/**
 * The sandbox proxy answers 502 when the sandbox is not running, such as when it is
 * paused or gone. The caller then asks the platform API to resume it.
 */
export class SandboxAway extends Schema.TaggedError<
	SandboxAway,
	{ readonly brand: unique symbol }
>()("SandboxAway", {}) {}

/** The user of the E2B templates. Old envd versions need it, and new ones accept it. */
const user = "user"

const headers = (connection: Connection) => ({
	authorization: `Basic ${Base64.encode(`${user}:`)}`,
	"e2b-sandbox-id": connection.sandboxId,
	"e2b-sandbox-port": String(envdPort),
	...(connection.accessToken === undefined
		? {}
		: { "x-access-token": connection.accessToken }),
})

const checked = (
	reply: Reply,
	what: string,
): Effect.Effect<Reply, ComputerCallFailed | SandboxAway> =>
	reply.status === 502
		? Effect.fail(SandboxAway.make())
		: ok(reply)
			? Effect.succeed(reply)
			: Effect.fail(failed(reply, what))

const callTimeoutMs = 60_000

/** One unary call of the Connect protocol with a JSON body. */
const unary = (
	client: HttpClient.HttpClient,
	connection: Connection,
	method: string,
	body: unknown,
) =>
	send(
		client,
		HttpClientRequest.post(`${connection.url}/${method}`).pipe(
			HttpClientRequest.setHeaders({
				...headers(connection),
				"connect-protocol-version": "1",
			}),
			HttpClientRequest.bodyJsonUnsafe(body),
		),
		callTimeoutMs,
	).pipe(
		Effect.flatMap((reply) => checked(reply, method)),
		Effect.map(json),
	)

const filesUrl = (connection: Connection, path: string) =>
	`${connection.url}/files?${new URLSearchParams({ path, username: user })}`

export const read = (
	client: HttpClient.HttpClient,
	connection: Connection,
	path: string,
) =>
	send(
		client,
		HttpClientRequest.get(filesUrl(connection, path)).pipe(
			HttpClientRequest.setHeaders(headers(connection)),
		),
		callTimeoutMs,
	).pipe(
		Effect.flatMap((reply) => checked(reply, `Reading ${path}`)),
		Effect.map((reply) => reply.body),
	)

/** Writes a file. envd makes the missing parent folders. */
export const write = (
	client: HttpClient.HttpClient,
	connection: Connection,
	path: string,
	bytes: Uint8Array,
) => {
	const form = new FormData()
	form.append("file", new Blob([bytes.slice()]), path)
	return send(
		client,
		HttpClientRequest.post(filesUrl(connection, path)).pipe(
			HttpClientRequest.setHeaders(headers(connection)),
			HttpClientRequest.bodyFormData(form),
		),
		callTimeoutMs,
	).pipe(
		Effect.flatMap((reply) => checked(reply, `Writing ${path}`)),
		Effect.asVoid,
	)
}

const entry = (value: unknown): ComputersApi.FileEntry => {
	const type = string(value, "type")
	const modified = string(value, "modifiedTime")
	const parsed = modified === undefined ? Number.NaN : Date.parse(modified)
	return {
		name: string(value, "name") ?? "",
		kind:
			field(value, "isSymlink") === true || type === "FILE_TYPE_SYMLINK"
				? "link"
				: type === "FILE_TYPE_DIRECTORY"
					? "directory"
					: "file",
		size: number(value, "size") ?? 0,
		modifiedAt: Number.isFinite(parsed) ? parsed : 0,
	}
}

export const list = (
	client: HttpClient.HttpClient,
	connection: Connection,
	path: string,
) =>
	unary(client, connection, "filesystem.Filesystem/ListDir", {
		path,
		depth: 1,
	}).pipe(
		Effect.map((body) => {
			const entries = field(body, "entries")
			return Arr.isArray(entries) ? Arr.map(entries, entry) : []
		}),
	)

/** Removes a file or a folder with all that is in it. */
export const remove = (
	client: HttpClient.HttpClient,
	connection: Connection,
	path: string,
) =>
	unary(client, connection, "filesystem.Filesystem/Remove", { path }).pipe(
		Effect.asVoid,
	)

/** Puts one JSON message in the envelope of the Connect protocol: flags, length, body. */
export const envelope = (message: unknown, flags = 0) => {
	const body = new TextEncoder().encode(JSON.stringify(message))
	const framed = new Uint8Array(5 + body.length)
	const view = new DataView(framed.buffer)
	view.setUint8(0, flags)
	view.setUint32(1, body.length)
	framed.set(body, 5)
	return framed
}

/** The flag of the last envelope of a stream. It holds the error, if there is one. */
const endOfStream = 0x02

interface Output {
	readonly pending: Uint8Array
	readonly pid: number | undefined
	readonly stdout: Tail
	readonly stderr: Tail
	readonly exitCode: number | undefined
	/** The error in the last envelope, or the error of the end event. */
	readonly error: string | undefined
}

const startOutput: Output = {
	pending: new Uint8Array(0),
	pid: undefined,
	stdout: emptyTail,
	stderr: emptyTail,
	exitCode: undefined,
	error: undefined,
}

const bytesOf = (value: string | undefined) =>
	value === undefined
		? new Uint8Array(0)
		: Result.getOrElse(Base64.decode(value), () => new Uint8Array(0))

/** The error in the last envelope of a stream, or `undefined` when there is none. */
const streamError = (message: unknown) => {
	const error = field(message, "error")
	return error === undefined
		? undefined
		: (string(error, "message") ?? string(error, "code") ?? "unknown error")
}

const onMessage = (output: Output, flags: number, message: unknown): Output => {
	if ((flags & endOfStream) !== 0) {
		const error = streamError(message)
		return error === undefined ? output : { ...output, error }
	}
	const event = field(message, "event")
	const start = field(event, "start")
	const data = field(event, "data")
	const end = field(event, "end")
	if (start !== undefined) return { ...output, pid: number(start, "pid") }
	if (data !== undefined)
		return {
			...output,
			stdout: appendTail(
				output.stdout,
				bytesOf(string(data, "stdout")),
				outputLimit,
			),
			stderr: appendTail(
				output.stderr,
				bytesOf(string(data, "stderr")),
				outputLimit,
			),
		}
	if (end !== undefined) {
		const error = string(end, "error")
		// Protobuf JSON leaves out a value of zero, so a missing exit code is 0.
		return {
			...output,
			exitCode: number(end, "exitCode") ?? 0,
			...(error === undefined || error === "" ? {} : { error }),
		}
	}
	return output
}

interface Envelope {
	readonly flags: number
	readonly message: unknown
}

/** Reads all the whole envelopes in the bytes so far, and keeps the rest for the next chunk. */
const events = (
	pending: Uint8Array,
	chunk: Uint8Array,
): {
	readonly found: ReadonlyArray<Envelope>
	readonly pending: Uint8Array
} => {
	const joined = new Uint8Array(pending.length + chunk.length)
	joined.set(pending, 0)
	joined.set(chunk, pending.length)
	const view = new DataView(joined.buffer)
	const found: Array<Envelope> = []
	let offset = 0
	while (offset + 5 <= joined.length) {
		const flags = view.getUint8(offset)
		const length = view.getUint32(offset + 1)
		if (offset + 5 + length > joined.length) break
		const body = new TextDecoder().decode(
			joined.subarray(offset + 5, offset + 5 + length),
		)
		found.push({ flags, message: parseJson(body) })
		offset += 5 + length
	}
	return { found, pending: joined.slice(offset) }
}

const onChunk = (output: Output, chunk: Uint8Array): Output => {
	const next = events(output.pending, chunk)
	const first: Output = { ...output, pending: next.pending }
	return Arr.reduce(next.found, first, (acc, each) =>
		onMessage(acc, each.flags, each.message),
	)
}

/** The request that starts a command with `bash -lc`. */
const startRequest = (
	connection: Connection,
	request: Pick<RunRequest, "command" | "cwd" | "env">,
	extra: Readonly<Record<string, unknown>>,
) =>
	HttpClientRequest.post(`${connection.url}/process.Process/Start`).pipe(
		HttpClientRequest.setHeaders({
			...headers(connection),
			"connect-protocol-version": "1",
			// envd sends keepalive events at this interval, in seconds, so that
			// proxies do not close a quiet stream.
			"keepalive-ping-interval": "50",
		}),
		HttpClientRequest.bodyUint8Array(
			envelope({
				process: {
					cmd: "/bin/bash",
					args: ["-l", "-c", request.command],
					envs: request.env ?? {},
					...(request.cwd === undefined ? {} : { cwd: request.cwd }),
				},
				...extra,
			}),
			"application/connect+json",
		),
	)

/**
 * Runs a command with `bash -lc` and waits for its end. At the timeout, OpenBot kills
 * the process and gives back the output so far, with `exitCode: null`.
 */
export const run = (
	client: HttpClient.HttpClient,
	connection: Connection,
	request: RunRequest,
) =>
	Effect.gen(function* () {
		const state = yield* Ref.make(startOutput)
		const timeoutMs = (request.timeout ?? 60) * 1000
		const http = startRequest(connection, request, { stdin: false })
		const finished = yield* client.execute(http).pipe(
			Effect.mapError(unreachable),
			Effect.flatMap((response) =>
				response.status === 200
					? response.stream.pipe(
							Stream.mapError(unreachable),
							Stream.runForEach((chunk) =>
								Ref.update(state, (output) => onChunk(output, chunk)),
							),
						)
					: Effect.flatMap(
							Effect.mapError(response.arrayBuffer, unreachable),
							(buffer) =>
								checked(
									{ status: response.status, body: new Uint8Array(buffer) },
									"Running the command",
								),
						),
			),
			Effect.timeoutOption(timeoutMs),
		)
		const output = yield* Ref.get(state)
		if (Option.isNone(finished) && output.pid !== undefined)
			yield* unary(client, connection, "process.Process/SendSignal", {
				process: { pid: output.pid },
				signal: "SIGNAL_SIGKILL",
			}).pipe(
				Background.logFailure(
					"OpenBot could not stop an E2B command after its timeout",
				),
			)
		if (Option.isSome(finished) && output.exitCode === undefined)
			return yield* ComputerCallFailed.make({
				message: `The command did not finish: ${output.error ?? "the stream ended early"}`,
				retry: true,
			})
		return {
			exitCode: Option.isNone(finished) ? null : (output.exitCode ?? null),
			stdout: tailText(output.stdout),
			stderr: tailText(output.stderr),
		} satisfies RunResult
	})

/** The signals that envd sends itself. The other signals go through `kill`. */
const envdSignals: Partial<Record<ComputersApi.SessionSignal, string>> = {
	SIGKILL: "SIGNAL_SIGKILL",
	SIGTERM: "SIGNAL_SIGTERM",
}

/** The words that Go uses for signals in the status of a process. */
const signalWords: Readonly<Record<string, string>> = {
	killed: "SIGKILL",
	terminated: "SIGTERM",
	interrupt: "SIGINT",
	hangup: "SIGHUP",
	quit: "SIGQUIT",
}

/**
 * Starts a command with `bash -lc` and gives its output as it comes. With `tty`, envd
 * gives it a terminal. Closing the Scope kills the process.
 */
export const start = (
	client: HttpClient.HttpClient,
	connection: Connection,
	request: StartRequest,
): Effect.Effect<Process, ComputerCallFailed | SandboxAway, Scope.Scope> =>
	Effect.gen(function* () {
		const sink = yield* ProcessSink.make
		// The stream fails it when it ends with no start event, so nobody waits
		// for a pid that cannot come.
		const pid = yield* Deferred.make<number, ComputerCallFailed>()
		const http = startRequest(connection, request, {
			...(request.tty
				? {
						pty: {
							size: { rows: request.rows ?? 24, cols: request.cols ?? 80 },
						},
					}
				: {}),
			stdin: true,
		})
		const response = yield* client
			.execute(http)
			.pipe(Effect.mapError(unreachable))
		if (response.status !== 200) {
			const buffer = yield* Effect.mapError(response.arrayBuffer, unreachable)
			return yield* checked(
				{ status: response.status, body: new Uint8Array(buffer) },
				"Starting the command",
			).pipe(
				Effect.andThen(
					Effect.fail(
						ComputerCallFailed.make({
							message: "The command did not start.",
							retry: true,
						}),
					),
				),
			)
		}
		/** True when envd reported the end of the process. */
		const ended = yield* Ref.make(false)
		/** Marks the end. It gives true only the first time. */
		const firstEnd = Effect.map(Ref.getAndSet(ended, true), (done) => !done)
		const onEvent = (flags: number, message: unknown) =>
			Effect.gen(function* () {
				if ((flags & endOfStream) !== 0) {
					const error = streamError(message)
					if (error !== undefined && (yield* firstEnd))
						yield* sink.end({ code: null, signal: null, error })
					return
				}
				const event = field(message, "event")
				const started = field(event, "start")
				const data = field(event, "data")
				const end = field(event, "end")
				if (started !== undefined) {
					const value = number(started, "pid")
					if (value !== undefined) yield* Deferred.succeed(pid, value)
				}
				if (data !== undefined) {
					yield* sink.push(bytesOf(string(data, "stdout")))
					yield* sink.push(bytesOf(string(data, "stderr")))
					yield* sink.push(bytesOf(string(data, "pty")))
				}
				if (end !== undefined && (yield* firstEnd)) {
					const error = string(end, "error")
					const status = string(end, "status") ?? ""
					// Go names the signal in words, such as `signal: killed`.
					const word = /signal: (\w+)/.exec(status)?.[1]
					const killed =
						word === undefined
							? undefined
							: Option.getOrElse(Rec.get(signalWords, word), () =>
									Str.toUpperCase(word),
								)
					yield* sink.end({
						// Protobuf JSON leaves out a value of zero, so a missing exit code is 0.
						code: killed === undefined ? (number(end, "exitCode") ?? 0) : null,
						signal: killed ?? null,
						...(error === undefined || error === "" ? {} : { error }),
					})
				}
			})
		yield* response.stream.pipe(
			Stream.mapAccum(
				(): Uint8Array => new Uint8Array(0),
				(pending, chunk) => {
					const next = events(pending, chunk)
					return [next.pending, next.found] as const
				},
			),
			Stream.runForEach((each) => onEvent(each.flags, each.message)),
			Background.logFailure("The E2B process stream failed"),
			Effect.annotateLogs({ sandbox: connection.sandboxId }),
			Effect.ensuring(
				Deferred.fail(
					pid,
					ComputerCallFailed.make({
						message: "The command did not start.",
						retry: true,
					}),
				).pipe(
					Effect.andThen(Ref.get(ended)),
					Effect.flatMap((done) =>
						done
							? Effect.void
							: sink.end({
									code: null,
									signal: null,
									error: "The stream ended early.",
								}),
					),
				),
			),
			Effect.forkScoped,
		)
		const withPid = <A>(
			use: (
				value: number,
			) => Effect.Effect<A, ComputerCallFailed | SandboxAway>,
		) =>
			Deferred.await(pid).pipe(
				Effect.timeoutOption("30 seconds"),
				Effect.flatMap((value) =>
					Option.isNone(value)
						? Effect.fail(
								ComputerCallFailed.make({
									message: "The command did not start in time.",
									retry: true,
								}),
							)
						: use(value.value),
				),
			)
		const sendInput = (bytes: Uint8Array) =>
			withPid((value) =>
				unary(client, connection, "process.Process/SendInput", {
					process: { pid: value },
					input: request.tty
						? { pty: Base64.encode(bytes) }
						: { stdin: Base64.encode(bytes) },
				}),
			)
		const signal = (name: ComputersApi.SessionSignal) =>
			withPid((value) => {
				const own = envdSignals[name]
				const bare = Str.slice(3)(name)
				return own !== undefined
					? unary(client, connection, "process.Process/SendSignal", {
							process: { pid: value },
							signal: own,
						})
					: run(client, connection, {
							command: `kill -s ${bare} -- -${value} 2>/dev/null || kill -s ${bare} ${value}`,
							timeout: 10,
						})
			}).pipe(Effect.asVoid)
		// A finalizer cannot be stopped, so the kill has its own time limit.
		yield* Effect.addFinalizer(() =>
			Effect.flatMap(Ref.get(ended), (done) =>
				done
					? Effect.void
					: signal("SIGKILL").pipe(
							Effect.timeout("10 seconds"),
							Background.logFailure("OpenBot could not stop an E2B process"),
							Effect.annotateLogs({ sandbox: connection.sandboxId }),
						),
			),
		)
		const process: Process = {
			output: sink.output,
			exit: sink.exit,
			write: (data) =>
				Effect.gen(function* () {
					// Without a terminal, Ctrl-D closes stdin, like the connector does.
					const stop = request.tty ? -1 : data.indexOf(0x04)
					const before = stop < 0 ? data : data.subarray(0, stop)
					if (before.length > 0) yield* sendInput(before)
					if (stop >= 0)
						yield* withPid((value) =>
							unary(client, connection, "process.Process/CloseStdin", {
								process: { pid: value },
							}),
						)
				}).pipe(Effect.catchTag("SandboxAway", () => Effect.fail(away))),
			resize: (rows, cols) =>
				request.tty
					? withPid((value) =>
							unary(client, connection, "process.Process/Update", {
								process: { pid: value },
								pty: { size: { rows, cols } },
							}),
						).pipe(
							Effect.asVoid,
							Effect.catchTag("SandboxAway", () => Effect.fail(away)),
						)
					: Effect.void,
			signal: (name) =>
				signal(name).pipe(
					Effect.catchTag("SandboxAway", () => Effect.fail(away)),
				),
		}
		return process
	})

const away = ComputerCallFailed.make({
	message: "The E2B sandbox does not answer.",
	retry: true,
})
