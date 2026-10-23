// These helpers send one request and read its answer. A pipeable form does not help here.
// @effect-diagnostics missingPipeableSignature:off
import { Effect, Predicate } from "effect"
import type { HttpClient, HttpClientRequest } from "effect/http"
import { ComputerCallFailed } from "./Computer.ts"

/** The answer of the provider, with the whole body. */
export interface Reply {
	readonly status: number
	readonly body: Uint8Array
}

const decoder = new TextDecoder()

export const unreachable = (cause: unknown) =>
	new ComputerCallFailed({
		message: `The Computer provider could not be reached: ${String(cause)}`,
		retry: true,
	})

export const timedOut = Effect.fail(
	new ComputerCallFailed({
		message: "The Computer provider did not answer in time",
		retry: true,
	}),
)

/** Sends one request and reads the whole body. Any HTTP status is a reply. */
export const send = (
	client: HttpClient.HttpClient,
	request: HttpClientRequest.HttpClientRequest,
	timeoutMs: number,
): Effect.Effect<Reply, ComputerCallFailed> =>
	client.execute(request).pipe(
		Effect.flatMap((response) =>
			Effect.map(response.arrayBuffer, (buffer): Reply => ({
				status: response.status,
				body: new Uint8Array(buffer),
			})),
		),
		Effect.mapError(unreachable),
		Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => timedOut }),
	)

export const ok = (reply: Reply) => reply.status >= 200 && reply.status < 300

export const text = (reply: Reply) => decoder.decode(reply.body)

/** The JSON body, or `undefined` when the body is not JSON. */
export const json = (reply: Reply): unknown => {
	try {
		return JSON.parse(text(reply))
	} catch {
		return undefined
	}
}

export const field = (value: unknown, key: string): unknown =>
	Predicate.isObject(value)
		? (value as Record<string, unknown>)[key]
		: undefined

export const string = (value: unknown, key: string) => {
	const found = field(value, key)
	return Predicate.isString(found) ? found : undefined
}

/** A number, or a number in a string. Protobuf JSON sends 64-bit numbers as strings. */
export const number = (value: unknown, key: string) => {
	const found = field(value, key)
	const parsed = Predicate.isString(found) ? Number(found) : found
	return Predicate.isNumber(parsed) && Number.isFinite(parsed)
		? parsed
		: undefined
}

/** The message that the provider put in an error body, kept short. */
const detail = (reply: Reply) => {
	const body = json(reply)
	const message =
		string(body, "message") ??
		string(body, "error") ??
		string(field(body, "error"), "message")
	return message === undefined ? "" : `: ${message.slice(0, 300)}`
}

/** Turns a failed answer into a call failure. A wrong key does not get better with a retry. */
export const failed = (reply: Reply, what: string) =>
	new ComputerCallFailed({
		message:
			reply.status === 401 || reply.status === 403
				? `The Computer provider did not accept the API key (HTTP ${reply.status})${detail(reply)}`
				: `${what} failed with HTTP ${reply.status}${detail(reply)}`,
		retry: reply.status === 429 || reply.status >= 500,
	})

/** Quotes a value for `bash`, so the shell reads it as one word. */
export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/** Reads the size of a PNG image from its header. */
export const pngSize = (bytes: Uint8Array) => {
	if (bytes.length < 24) return undefined
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** Keeps only the last `limit` bytes. */
export interface Tail {
	readonly bytes: Uint8Array
	readonly truncated: boolean
}

export const emptyTail: Tail = { bytes: new Uint8Array(0), truncated: false }

export const appendTail = (
	tail: Tail,
	chunk: Uint8Array,
	limit: number,
): Tail => {
	const joined = new Uint8Array(tail.bytes.length + chunk.length)
	joined.set(tail.bytes, 0)
	joined.set(chunk, tail.bytes.length)
	return joined.length <= limit
		? { bytes: joined, truncated: tail.truncated }
		: { bytes: joined.slice(joined.length - limit), truncated: true }
}

export const tailText = (tail: Tail) => decoder.decode(tail.bytes)

/** Commands keep at most this many bytes of stdout and of stderr. */
export const outputLimit = 100_000
