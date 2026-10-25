// These helpers send one request and read its answer. A pipeable form does not help here.
// @effect-diagnostics missingPipeableSignature:off
import { Crypto, Data, Effect, Option } from "effect"
import { Hex } from "effect/encoding"
import { HttpClientRequest, type HttpClient } from "effect/http"

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
	readonly secretAccessKey: string
	readonly forcePathStyle: boolean
}

export class StorageError extends Data.TaggedError("StorageError")<{
	readonly message: string
}> {}

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
		return yield* crypto.digest("SHA-256", bytes(value)).pipe(
			Effect.mapError(
				(cause) =>
					new StorageError({
						message: `The object storage could not sign the request: ${cause.message}`,
					}),
			),
		)
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

/** Encodes like RFC 3986, as Signature Version 4 needs. */
const encode = (value: string) =>
	encodeURIComponent(value).replace(
		/[!'()*]/g,
		(char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
	)

/** The time stamps of a signature, such as `20130524T000000Z` and `20130524`. */
const stamps = (now: number) => {
	const iso = new Date(now).toISOString().replace(/[-:]/g, "")
	const amzDate = iso.slice(0, 15) + "Z"
	return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

/** The address of one object. `endpoint` can be another address of the same storage. */
export const objectUrl = (
	target: Target,
	key: string,
	endpoint: string = target.endpoint,
): URL => {
	const base = new URL(endpoint)
	const path = key.split("/").map(encode).join("/")
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
	const names = Object.keys(input.headers)
		.map((name) => name.toLowerCase())
		.sort()
	const lower = Object.fromEntries(
		Object.entries(input.headers).map(([name, value]) => [
			name.toLowerCase(),
			value.trim(),
		]),
	)
	const query = input.query
		.map(([name, value]) => [encode(name), encode(value)] as const)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([name, value]) => name + "=" + value)
		.join("&")
	const canonical = [
		input.method,
		input.url.pathname,
		query,
		names.map((name) => name + ":" + lower[name] + "\n").join(""),
		names.join(";"),
		input.payloadHash,
	].join("\n")
	const scope = `${input.dateStamp}/${target.region}/s3/aws4_request`
	const toSign = [
		"AWS4-HMAC-SHA256",
		input.amzDate,
		scope,
		yield* sha256(canonical),
	].join("\n")
	const dateKey = yield* hmac("AWS4" + target.secretAccessKey, input.dateStamp)
	const regionKey = yield* hmac(dateKey, target.region)
	const serviceKey = yield* hmac(regionKey, "s3")
	const key = yield* hmac(serviceKey, "aws4_request")
	return {
		signedHeaders: names.join(";"),
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
}): Effect.fn.Return<string, StorageError, Crypto.Crypto> {
	const url = objectUrl(input.target, input.key, input.endpoint)
	const { amzDate, dateStamp } = stamps(input.now)
	const headers = { ...input.headers, host: url.host }
	const names = Object.keys(headers)
		.map((name) => name.toLowerCase())
		.sort()
	const scope = `${dateStamp}/${input.target.region}/s3/aws4_request`
	const query: Array<readonly [string, string]> = [
		["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
		["X-Amz-Credential", `${input.target.accessKeyId}/${scope}`],
		["X-Amz-Date", amzDate],
		["X-Amz-Expires", String(input.expiresSeconds)],
		["X-Amz-SignedHeaders", names.join(";")],
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
	url.search = [...query, ["X-Amz-Signature", signed.value] as const]
		.map(([name, value]) => encode(name) + "=" + encode(value))
		.join("&")
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

const send = (
	client: HttpClient.HttpClient,
	request: Effect.Effect<
		HttpClientRequest.HttpClientRequest,
		StorageError,
		Crypto.Crypto
	>,
	what: string,
) =>
	Effect.flatMap(request, client.execute).pipe(
		Effect.flatMap((response) =>
			Effect.map(response.arrayBuffer, (buffer) => ({
				status: response.status,
				headers: response.headers,
				body: new Uint8Array(buffer),
			})),
		),
		Effect.mapError((cause) =>
			cause instanceof StorageError
				? cause
				: new StorageError({
						message: `The object storage could not ${what}: ${String(cause)}`,
					}),
		),
		Effect.timeoutOrElse({
			duration: timeoutMs,
			orElse: () =>
				Effect.fail(
					new StorageError({
						message: `The object storage could not ${what}: no answer in time`,
					}),
				),
		}),
	)

const ok = (status: number) => status >= 200 && status < 300

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
				: Effect.fail(
						new StorageError({
							message: `The object storage could not store the file: status ${reply.status}`,
						}),
					),
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
					: Effect.fail(
							new StorageError({
								message: `The object storage could not read the file: status ${reply.status}`,
							}),
						),
	)

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
			if (!ok(reply.status))
				return Effect.fail(
					new StorageError({
						message: `The object storage could not check the file: status ${reply.status}`,
					}),
				)
			const bytes = Number(reply.headers["content-length"])
			return Number.isFinite(bytes)
				? Effect.succeedSome({
						bytes,
						contentType: reply.headers["content-type"],
					})
				: Effect.fail(
						new StorageError({
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
				: Effect.fail(
						new StorageError({
							message: `The object storage could not delete the file: status ${reply.status}`,
						}),
					),
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
				: Effect.fail(
						new StorageError({
							message: `The object storage could not make the bucket: status ${reply.status}`,
						}),
					),
	)
