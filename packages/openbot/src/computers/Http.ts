import type { ComputersApi } from "@openbot-build/api"
import {
	Cause,
	Effect,
	Option,
	Predicate,
	pipe,
	Schema,
	String as Str,
} from "effect"
import { Base64 } from "effect/encoding"
import type { HttpClient, HttpClientRequest } from "effect/http"
import { ComputerCallFailed, type ComputerError } from "./Computer.ts"

/** The answer of the provider, with the whole body. */
export interface Reply {
	readonly status: number
	readonly body: Uint8Array
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

export const timedOut = Effect.fail(
	ComputerCallFailed.make({
		message: "The Computer provider did not answer in time",
		retry: true,
	}),
)

/**
 * The request did not reach the provider, or its answer did not come back. The
 * message stays short, because it goes to clients. The cause holds the reason,
 * such as a refused connection, and the address of the request.
 */
export const unreachable = (cause: unknown) =>
	ComputerCallFailed.make({
		message: "The Computer provider could not be reached",
		retry: true,
		cause,
	})

/**
 * Logs a call failure that has an inside cause, with that cause. The message of
 * a failure without one, such as a wrong key, says enough, so it is not logged.
 */
export const logCause = (error: ComputerError) =>
	error._tag === "ComputerCallFailed" && error.cause !== undefined
		? Effect.logWarning("A Computer provider call failed", Cause.fail(error))
		: Effect.void

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

const decodeJson = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Unknown),
)

/** The JSON value of the text, or `undefined` when the text is not JSON. */
export const parseJson = (value: string): unknown =>
	Option.getOrUndefined(decodeJson(value))

/** The JSON body, or `undefined` when the body is not JSON. */
export const json = (reply: Reply): unknown => parseJson(text(reply))

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
	return message === undefined ? "" : `: ${pipe(message, Str.slice(0, 300))}`
}

/** Turns a failed answer into a call failure. A wrong key does not get better with a retry. */
export const failed = (reply: Reply, what: string) =>
	ComputerCallFailed.make({
		message:
			reply.status === 401 || reply.status === 403
				? `The Computer provider did not accept the API key (HTTP ${reply.status})${detail(reply)}`
				: `${what} failed with HTTP ${reply.status}${detail(reply)}`,
		retry: reply.status === 429 || reply.status >= 500,
	})

/** The bytes of a file as the API gives them, as UTF-8 text or in base64. */
export const fileContent = (
	path: string,
	encoding: ComputersApi.FileEncoding,
	bytes: Uint8Array,
): ComputersApi.FileContent => ({
	path,
	encoding,
	content: encoding === "base64" ? Base64.encode(bytes) : decoder.decode(bytes),
})

/** The bytes of a file that the API gives, as UTF-8 text or in base64. */
export const fileBytes = (
	file: ComputersApi.FileContent,
): Effect.Effect<Uint8Array, ComputerCallFailed> =>
	file.encoding === "base64"
		? Base64.decode(file.content).pipe(
				Effect.fromResult,
				Effect.mapError((error) =>
					ComputerCallFailed.make({
						message: `The file content is not valid base64: ${error.message}`,
						retry: false,
					}),
				),
			)
		: Effect.succeed(encoder.encode(file.content))

/** Quotes a value for `bash`, so the shell reads it as one word. */
export const quote = (value: string) =>
	`'${pipe(value, Str.replaceAll("'", `'\\''`))}'`

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
