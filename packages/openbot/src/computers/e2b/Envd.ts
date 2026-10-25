// These calls take a connection and a request, like the envd API. A pipeable form does not help here.
// @effect-diagnostics missingPipeableSignature:off
import type { ComputersApi } from "@openbot-build/api"
import {
	Clock,
	Deferred,
	Effect,
	Option,
	Ref,
	Result,
	Schema,
	type Scope,
	Stream,
} from "effect"
import { Base64 } from "effect/encoding"
import { type HttpClient, HttpClientRequest } from "effect/http"
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
export class SandboxAway extends Schema.TaggedError<SandboxAway>()(
	"SandboxAway",
	{},
) {}

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
			return Array.isArray(entries) ? entries.map(entry) : []
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

const onMessage = (output: Output, flags: number, message: unknown): Output => {
	if ((flags & endOfStream) !== 0) {
		const error = field(message, "error")
		return error === undefined
			? output
			: {
					...output,
					error:
						string(error, "message") ??
						string(error, "code") ??
						"unknown error",
				}
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

/** Reads all the whole envelopes in the bytes so far, and keeps the rest for the next chunk. */
const onChunk = (output: Output, chunk: Uint8Array): Output => {
	const joined = new Uint8Array(output.pending.length + chunk.length)
	joined.set(output.pending, 0)
	joined.set(chunk, output.pending.length)
	const view = new DataView(joined.buffer)
	let next: Output = output
	let offset = 0
	while (offset + 5 <= joined.length) {
		const flags = view.getUint8(offset)
		const length = view.getUint32(offset + 1)
		if (offset + 5 + length > joined.length) break
		const body = new TextDecoder().decode(
			joined.subarray(offset + 5, offset + 5 + length),
		)
		next = onMessage(next, flags, parseJson(body))
		offset += 5 + length
	}
	return { ...next, pending: joined.slice(offset) }
}

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
		const startedAt = yield* Clock.currentTimeMillis
		const state = yield* Ref.make(startOutput)
		const timeoutMs = (request.timeout ?? 60) * 1000
		const http = HttpClientRequest.post(
			`${connection.url}/process.Process/Start`,
		).pipe(
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
					stdin: false,
				}),
				"application/connect+json",
			),
		)
		const finished = yield* client.execute(http).pipe(
			Effect.mapError((cause) =>
				ComputerCallFailed.make({
					message: `The Computer provider could not be reached: ${String(cause)}`,
					retry: true,
				}),
			),
			Effect.flatMap((response) =>
				response.status === 200
					? response.stream.pipe(
							Stream.mapError((cause) =>
								ComputerCallFailed.make({
									message: `The Computer provider could not be reached: ${String(cause)}`,
									retry: true,
								}),
							),
							Stream.runForEach((chunk) =>
								Ref.update(state, (output) => onChunk(output, chunk)),
							),
						)
					: Effect.flatMap(
							Effect.mapError(response.arrayBuffer, (cause) =>
								ComputerCallFailed.make({
									message: `The Computer provider could not be reached: ${String(cause)}`,
									retry: true,
								}),
							),
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
		const endedAt = yield* Clock.currentTimeMillis
		if (Option.isNone(finished) && output.pid !== undefined)
			yield* unary(client, connection, "process.Process/SendSignal", {
				process: { pid: output.pid },
				signal: "SIGNAL_SIGKILL",
			}).pipe(Effect.ignore)
		if (Option.isSome(finished) && output.exitCode === undefined)
			return yield* ComputerCallFailed.make({
				message: `The command did not finish: ${output.error ?? "the stream ended early"}`,
				retry: true,
			})
		return {
			exitCode: Option.isNone(finished) ? null : (output.exitCode ?? null),
			stdout: tailText(output.stdout),
			stderr: tailText(output.stderr),
			truncated: output.stdout.truncated || output.stderr.truncated,
			durationMs: endedAt - startedAt,
		} satisfies RunResult
	})

/** The signals that envd sends itself. The other signals go through `kill`. */
const envdSignals: Partial<Record<ComputersApi.SessionSignal, string>> = {
	SIGKILL: "SIGNAL_SIGKILL",
	SIGTERM: "SIGNAL_SIGTERM",
}

/** The words that Go uses for signals in the status of a process. */
const signalWords: Record<string, string> = {
	killed: "SIGKILL",
	terminated: "SIGTERM",
	interrupt: "SIGINT",
	hangup: "SIGHUP",
	quit: "SIGQUIT",
}

/** Reads the events of a process stream from whole envelopes, and keeps the rest. */
const events = (pending: Uint8Array, chunk: Uint8Array) => {
	const joined = new Uint8Array(pending.length + chunk.length)
	joined.set(pending, 0)
	joined.set(chunk, pending.length)
	const view = new DataView(joined.buffer)
	const found: Array<{ readonly flags: number; readonly message: unknown }> = []
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
		const pid = yield* Deferred.make<number>()
		const unreachable = (cause: unknown) =>
			ComputerCallFailed.make({
				message: `The Computer provider could not be reached: ${String(cause)}`,
				retry: true,
			})
		const http = HttpClientRequest.post(
			`${connection.url}/process.Process/Start`,
		).pipe(
			HttpClientRequest.setHeaders({
				...headers(connection),
				"connect-protocol-version": "1",
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
					...(request.tty
						? {
								pty: {
									size: { rows: request.rows ?? 24, cols: request.cols ?? 80 },
								},
							}
						: {}),
					stdin: true,
				}),
				"application/connect+json",
			),
		)
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
		let pending = new Uint8Array(0)
		let ended = false
		const onEvent = (flags: number, message: unknown) =>
			Effect.gen(function* () {
				if ((flags & endOfStream) !== 0) {
					const error = field(message, "error")
					if (error !== undefined && !ended) {
						ended = true
						yield* sink.end({
							code: null,
							signal: null,
							error:
								string(error, "message") ??
								string(error, "code") ??
								"unknown error",
						})
					}
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
				if (end !== undefined && !ended) {
					ended = true
					const error = string(end, "error")
					const status = string(end, "status") ?? ""
					// Go names the signal in words, such as `signal: killed`.
					const word = /signal: (\w+)/.exec(status)?.[1]
					const killed =
						word === undefined
							? undefined
							: (signalWords[word] ?? word.toUpperCase())
					yield* sink.end({
						// Protobuf JSON leaves out a value of zero, so a missing exit code is 0.
						code: killed === undefined ? (number(end, "exitCode") ?? 0) : null,
						signal: killed ?? null,
						...(error === undefined || error === "" ? {} : { error }),
					})
				}
			})
		yield* response.stream.pipe(
			Stream.runForEach((chunk) =>
				Effect.gen(function* () {
					const next = events(pending, chunk)
					pending = next.pending
					for (const each of next.found)
						yield* onEvent(each.flags, each.message)
				}),
			),
			Effect.ignoreCause,
			Effect.ensuring(
				Effect.suspend(() =>
					ended
						? Effect.void
						: sink.end({
								code: null,
								signal: null,
								error: "The stream ended early.",
							}),
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
				return own !== undefined
					? unary(client, connection, "process.Process/SendSignal", {
							process: { pid: value },
							signal: own,
						})
					: run(client, connection, {
							command: `kill -s ${name.slice(3)} -- -${value} 2>/dev/null || kill -s ${name.slice(3)} ${value}`,
							timeout: 10,
						})
			}).pipe(Effect.asVoid)
		yield* Effect.addFinalizer(() =>
			ended ? Effect.void : Effect.ignore(signal("SIGKILL")),
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
