import {
	Array as Arr,
	Crypto,
	DateTime,
	Effect,
	Option,
	Order,
	pipe,
	Record as Rec,
	Redacted,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { Hex } from "effect/encoding"
import {
	HttpClientRequest,
	type HttpClient,
	type HttpClientError,
	type HttpClientResponse,
} from "effect/http"

/**
 * A small client for object storage that speaks the S3 API. It signs each
 * request with AWS Signature Version 4, and sends it with the HTTP client of
 * OpenBot, so the outbound guard checks every connection.
 */
export interface Target {
	readonly endpoint: string
	readonly region: string
	readonly bucket: string
	readonly accessKeyId: string
	readonly secretAccessKey: Redacted.Redacted<string>
	readonly forcePathStyle: boolean
}

export class StorageError extends Schema.TaggedError<
	StorageError,
	{ readonly brand: unique symbol }
>()("StorageError", {
	message: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

/** What a HEAD request says about an object. */
export interface Head {
	readonly bytes: number
	readonly contentType: string | undefined
}

const timeoutMs = 60_000
const unsignedPayload = "UNSIGNED-PAYLOAD"
const blockBytes = 64

const bytes = (value: string | Uint8Array) =>
	typeof value === "string" ? new TextEncoder().encode(value) : value

const digest = (value: string | Uint8Array) =>
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto
		// A platform without SHA-256 is broken, so a failure here is a defect.
		return yield* crypto.digest("SHA-256", bytes(value)).pipe(Effect.orDie)
	})

const sha256 = (value: string | Uint8Array) =>
	Effect.map(digest(value), Hex.encode)

const concat = (a: Uint8Array, b: Uint8Array) => {
	const joined = new Uint8Array(a.length + b.length)
	joined.set(a)
	joined.set(b, a.length)
	return joined
}

/**
 * HMAC-SHA256 from RFC 2104, made from the digest of the Crypto service,
 * because that service has no HMAC of its own.
 */
const hmac = (key: string | Uint8Array, value: string) =>
	Effect.gen(function* () {
		const raw = bytes(key)
		const short = raw.length > blockBytes ? yield* digest(raw) : raw
		const padded = concat(short, new Uint8Array(blockBytes - short.length))
		const inner = yield* digest(
			concat(
				padded.map((byte) => byte ^ 0x36),
				bytes(value),
			),
		)
		return yield* digest(
			concat(
				padded.map((byte) => byte ^ 0x5c),
				inner,
			),
		)
	})

/**
 * Encodes like RFC 3986, as Signature Version 4 needs. `encodeURIComponent`
 * does not encode `!'()*`, so they get their codes here.
 */
const encode = (value: string) =>
	pipe(
		encodeURIComponent(value),
		Str.replaceAll("!", "%21"),
		Str.replaceAll("'", "%27"),
		Str.replaceAll("(", "%28"),
		Str.replaceAll(")", "%29"),
		Str.replaceAll("*", "%2A"),
	)

/** The time stamps of a signature, such as `20130524T000000Z` and `20130524`. */
const stamps = (now: number) => {
	const iso = pipe(
		DateTime.formatIso(DateTime.makeUnsafe(now)),
		Str.replace(/[-:]/g, ""),
	)
	const amzDate = Str.slice(0, 15)(iso) + "Z"
	return { amzDate, dateStamp: Str.slice(0, 8)(amzDate) }
}

/** The names of the signed headers: in lower case, and in order. */
const headerNames = (headers: Readonly<Record<string, string>>) =>
	pipe(Rec.keys(headers), Arr.map(Str.toLowerCase), Arr.sort(Order.String))

/** The order of query parameters: by name only. */
const byName = Order.mapInput(
	Order.String,
	([name]: readonly [string, string]) => name,
)

/** The address of one object. `endpoint` can be another address of the same storage. */
export const objectUrl = (
	target: Target,
	key: string,
	endpoint: string = target.endpoint,
): URL => {
	const base = new URL(endpoint)
	const path = pipe(key, Str.split("/"), Arr.map(encode), Arr.join("/"))
	if (target.forcePathStyle) {
		// An empty key names the bucket itself.
		base.pathname = "/" + encode(target.bucket) + (key === "" ? "" : "/" + path)
		return base
	}
	base.hostname = target.bucket + "." + base.hostname
	base.pathname = "/" + path
	return base
}

const signature = Effect.fnUntraced(function* (input: {
	readonly target: Target
	readonly method: string
	readonly url: URL
	readonly query: ReadonlyArray<readonly [string, string]>
	readonly headers: Readonly<Record<string, string>>
	readonly payloadHash: string
	readonly amzDate: string
	readonly dateStamp: string
}) {
	const { target } = input
	const names = headerNames(input.headers)
	const lower = Rec.mapEntries(input.headers, (value, name) => [
		Str.toLowerCase(name),
		Str.trim(value),
	])
	const query = pipe(
		input.query,
		Arr.map(([name, value]) => [encode(name), encode(value)] as const),
		Arr.sort(byName),
		Arr.map(([name, value]) => name + "=" + value),
		Arr.join("&"),
	)
	const canonical = Arr.join(
		[
			input.method,
			input.url.pathname,
			query,
			pipe(
				names,
				Arr.map((name) => name + ":" + lower[name] + "\n"),
				Arr.join(""),
			),
			Arr.join(names, ";"),
			input.payloadHash,
		],
		"\n",
	)
	const scope = `${input.dateStamp}/${target.region}/s3/aws4_request`
	const toSign = Arr.join(
		["AWS4-HMAC-SHA256", input.amzDate, scope, yield* sha256(canonical)],
		"\n",
	)
	const dateKey = yield* hmac(
		"AWS4" + Redacted.value(target.secretAccessKey),
		input.dateStamp,
	)
	const regionKey = yield* hmac(dateKey, target.region)
	const serviceKey = yield* hmac(regionKey, "s3")
	const key = yield* hmac(serviceKey, "aws4_request")
	return {
		signedHeaders: Arr.join(names, ";"),
		credential: `${target.accessKeyId}/${scope}`,
		value: Hex.encode(yield* hmac(key, toSign)),
	}
})

/**
 * A signed address that works without other credentials until it expires.
 * The client must send each of `headers` with the same value.
 */
export const presign = Effect.fnUntraced(function* (input: {
	readonly target: Target
	readonly method: "GET" | "PUT"
	readonly key: string
	readonly endpoint?: string | undefined
	readonly headers?: Readonly<Record<string, string>>
	readonly expiresSeconds: number
	readonly now: number
}): Effect.fn.Return<string, never, Crypto.Crypto> {
	const url = objectUrl(input.target, input.key, input.endpoint)
	const { amzDate, dateStamp } = stamps(input.now)
	const headers = { ...input.headers, host: url.host }
	const names = headerNames(headers)
	const scope = `${dateStamp}/${input.target.region}/s3/aws4_request`
	const query: ReadonlyArray<readonly [string, string]> = [
		["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
		["X-Amz-Credential", `${input.target.accessKeyId}/${scope}`],
		["X-Amz-Date", amzDate],
		["X-Amz-Expires", String(input.expiresSeconds)],
		["X-Amz-SignedHeaders", Arr.join(names, ";")],
	]
	const signed = yield* signature({
		target: input.target,
		method: input.method,
		url,
		query,
		headers,
		payloadHash: unsignedPayload,
		amzDate,
		dateStamp,
	})
	url.search = pipe(
		Arr.append(query, ["X-Amz-Signature", signed.value] as const),
		Arr.map(([name, value]) => encode(name) + "=" + encode(value)),
		Arr.join("&"),
	)
	return url.toString()
})

/** A request with the signature in its headers. */
const signedRequest = Effect.fnUntraced(function* (input: {
	readonly target: Target
	readonly method: "GET" | "PUT" | "HEAD" | "DELETE"
	readonly key: string
	readonly body?: { readonly bytes: Uint8Array; readonly contentType: string }
	readonly now: number
}) {
	const url = objectUrl(input.target, input.key)
	const { amzDate, dateStamp } = stamps(input.now)
	const payloadHash = yield* sha256(input.body?.bytes ?? "")
	const headers: Record<string, string> = {
		host: url.host,
		"x-amz-content-sha256": payloadHash,
		"x-amz-date": amzDate,
		...(input.body === undefined
			? {}
			: { "content-type": input.body.contentType }),
	}
	const signed = yield* signature({
		target: input.target,
		method: input.method,
		url,
		query: [],
		headers,
		payloadHash,
		amzDate,
		dateStamp,
	})
	// Fetch sets the host header itself, from the same address.
	const { host: _, ...sent } = headers
	const request = HttpClientRequest.make(input.method)(url).pipe(
		HttpClientRequest.setHeaders({
			...sent,
			authorization: `AWS4-HMAC-SHA256 Credential=${signed.credential}, SignedHeaders=${signed.signedHeaders}, Signature=${signed.value}`,
		}),
	)
	return input.body === undefined
		? request
		: HttpClientRequest.bodyUint8Array(
				request,
				input.body.bytes,
				input.body.contentType,
			)
})

/** A failure of the HTTP client, kept as the cause of a storage error. */
const failed = (what: string) => (cause: HttpClientError.HttpClientError) =>
	StorageError.make({
		message: `The object storage could not ${what}: ${cause.message}`,
		cause,
	})

/** Fails when `effect` takes longer than the time limit. */
const inTime =
	(what: string) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.timeoutOrElse(effect, {
			duration: timeoutMs,
			orElse: () =>
				Effect.fail(
					StorageError.make({
						message: `The object storage could not ${what}: no answer in time`,
					}),
				),
		})

/** An answer with its whole body. */
interface Reply {
	readonly status: number
	readonly headers: HttpClientResponse.HttpClientResponse["headers"]
	readonly body: Uint8Array
}

const replyOf = (response: HttpClientResponse.HttpClientResponse) =>
	Effect.map(response.arrayBuffer, (buffer): Reply => ({
		status: response.status,
		headers: response.headers,
		body: new Uint8Array(buffer),
	}))

/** Signs and sends a request, and reads the whole answer in the time limit. */
const send = (
	client: HttpClient.HttpClient,
	request: Effect.Effect<
		HttpClientRequest.HttpClientRequest,
		never,
		Crypto.Crypto
	>,
	what: string,
) =>
	Effect.flatMap(request, (signed) => client.execute(signed)).pipe(
		Effect.flatMap(replyOf),
		Effect.mapError(failed(what)),
		inTime(what),
	)

const ok = (status: number) => status >= 200 && status < 300

/** The reason in an S3 error body, such as `AccessDenied` or `NoSuchBucket`. */
const errorCode = (body: Uint8Array) =>
	pipe(
		new TextDecoder().decode(body),
		Str.match(/<Code>([^<]+)<\/Code>/),
		Option.flatMap((found) => Option.fromNullishOr(found[1])),
	)

/**
 * The error for an answer with a bad status. It keeps the S3 error code of
 * the body, but not the rest of the body.
 */
const refused = (what: string, reply: Reply) => {
	const status = `The object storage could not ${what}: status ${reply.status}`
	return StorageError.make({
		message: Option.match(errorCode(reply.body), {
			onNone: () => status,
			onSome: (code) => `${status} (${code})`,
		}),
	})
}

export const put = (
	client: HttpClient.HttpClient,
	target: Target,
	key: string,
	body: { readonly bytes: Uint8Array; readonly contentType: string },
	now: number,
): Effect.Effect<void, StorageError, Crypto.Crypto> =>
	Effect.flatMap(
		send(
			client,
			signedRequest({ target, method: "PUT", key, body, now }),
			"store the file",
		),
		(reply) =>
			ok(reply.status)
				? Effect.void
				: Effect.fail(refused("store the file", reply)),
	)

/** The bytes of an object, or none when it is not there. */
export const get = (
	client: HttpClient.HttpClient,
	target: Target,
	key: string,
	now: number,
): Effect.Effect<Option.Option<Uint8Array>, StorageError, Crypto.Crypto> =>
	Effect.flatMap(
		send(
			client,
			signedRequest({ target, method: "GET", key, now }),
			"read the file",
		),
		(reply) =>
			reply.status === 404
				? Effect.succeedNone
				: ok(reply.status)
					? Effect.succeedSome(reply.body)
					: Effect.fail(refused("read the file", reply)),
	)

/**
 * The bytes of an object as a stream, or none when it is not there. The time
 * limit covers only the start of the answer, so a large file may take longer.
 */
export const getStream = Effect.fnUntraced(function* (
	client: HttpClient.HttpClient,
	target: Target,
	key: string,
	now: number,
): Effect.fn.Return<
	Option.Option<Stream.Stream<Uint8Array, StorageError>>,
	StorageError,
	Crypto.Crypto
> {
	const what = "read the file"
	const signed = yield* signedRequest({ target, method: "GET", key, now })
	const response = yield* client
		.execute(signed)
		.pipe(Effect.mapError(failed(what)), inTime(what))
	if (ok(response.status))
		return Option.some(Stream.mapError(response.stream, failed(what)))
	// The body of an error is small. Reading it frees the connection.
	const reply = yield* replyOf(response).pipe(
		Effect.mapError(failed(what)),
		inTime(what),
	)
	if (reply.status === 404) return Option.none()
	return yield* refused(what, reply)
})

/** The size and type of an object, or none when it is not there. */
export const head = (
	client: HttpClient.HttpClient,
	target: Target,
	key: string,
	now: number,
): Effect.Effect<Option.Option<Head>, StorageError, Crypto.Crypto> =>
	Effect.flatMap(
		send(
			client,
			signedRequest({ target, method: "HEAD", key, now }),
			"check the file",
		),
		(reply) => {
			if (reply.status === 404) return Effect.succeedNone
			// A HEAD answer has no body, so the error has only the status.
			if (!ok(reply.status))
				return Effect.fail(refused("check the file", reply))
			const bytes = Number(reply.headers["content-length"])
			return Number.isFinite(bytes)
				? Effect.succeedSome({
						bytes,
						contentType: reply.headers["content-type"],
					})
				: Effect.fail(
						StorageError.make({
							message: `The object storage could not check the file: no content-length`,
						}),
					)
		},
	)

/** Deletes an object. An object that is not there is already deleted. */
export const remove = (
	client: HttpClient.HttpClient,
	target: Target,
	key: string,
	now: number,
): Effect.Effect<void, StorageError, Crypto.Crypto> =>
	Effect.flatMap(
		send(
			client,
			signedRequest({ target, method: "DELETE", key, now }),
			"delete the file",
		),
		(reply) =>
			ok(reply.status) || reply.status === 404
				? Effect.void
				: Effect.fail(refused("delete the file", reply)),
	)

/** Makes the bucket. A bucket that is already there is fine. Only development uses it. */
export const createBucket = (
	client: HttpClient.HttpClient,
	target: Target,
	now: number,
): Effect.Effect<void, StorageError, Crypto.Crypto> =>
	Effect.flatMap(
		send(
			client,
			signedRequest({ target, method: "PUT", key: "", now }),
			"make the bucket",
		),
		(reply) =>
			ok(reply.status) || reply.status === 409
				? Effect.void
				: Effect.fail(refused("make the bucket", reply)),
	)
