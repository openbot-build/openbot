import * as HttpNetwork from "./HttpNetwork.ts"
import {
	StreamableHTTPClientTransport,
	type FetchLike,
	type JSONRPCMessage,
} from "@modelcontextprotocol/client"
import {
	Array as Arr,
	Effect,
	Exit,
	pipe,
	Predicate,
	Record as Rec,
	Scope,
	Stream,
	String as Str,
} from "effect"
import { HttpClientRequest } from "effect/http"
import * as Network from "./Network.ts"

/** In this HTTP revision, aborting the response stream signals cancellation. */
export class HttpTransport extends StreamableHTTPClientTransport {
	public override send(
		message: JSONRPCMessage,
		options?: Parameters<StreamableHTTPClientTransport["send"]>[1],
	): Promise<void> {
		// When SDK 2.3.1 tears down listen, it also sends the transport-independent notification.
		// Its request AbortController has already closed the real HTTP stream.
		if (
			Predicate.hasProperty(message, "method") &&
			message.method === "notifications/cancelled" &&
			!Predicate.hasProperty(message, "id")
		)
			return Promise.resolve()
		return super.send(message, options)
	}
}

/** The reply body holds decoded bytes, so it must not report the compressed encoding or length. */
const decodedHeaders = (headers: Readonly<Record<string, string>>) =>
	Rec.remove(Rec.remove(headers, "content-encoding"), "content-length")

/** The type and subtype of a Content-Type value, without its parameters. */
const mediaType = (headers: Readonly<Record<string, string>>) =>
	pipe(
		headers["content-type"] ?? "",
		Str.split(";"),
		Arr.headNonEmpty,
		Str.trim,
		Str.toLowerCase,
	)

/** Normal tool results with images or resources fit in this many bytes. */
const defaultMaxMessageBytes = 16 * 1024 * 1024

/** Promise conversion happens only in callbacks that the external SDK calls. */
export const fetch = Effect.fn("Sdk.fetch")(function* (
	options: {
		readonly documents?: boolean
		/**
		 * The largest JSON body, or the largest single SSE (server-sent events)
		 * event, that the SDK may read from one response.
		 */
		readonly maxMessageBytes?: number
	} = {},
) {
	const maxMessageBytes = options.maxMessageBytes ?? defaultMaxMessageBytes
	const network = yield* Network.Network
	const ownerScope = yield* Effect.scope
	const context = yield* Effect.context<Scope.Scope>()
	// A failed Effect rejects the Promise, which is how a fetch callback reports an error.
	const run = Effect.runPromiseWith(context)
	const fork = Effect.runForkWith(context)
	const callback: FetchLike = (input, init) => {
		const request = new Request(input, init)
		return run(
			Effect.gen(function* () {
				const scope = yield* Scope.fork(ownerScope)
				const close = () => {
					fork(Scope.close(scope, Exit.void))
				}
				request.signal.addEventListener("abort", close, { once: true })
				yield* Scope.addFinalizer(
					scope,
					Effect.sync(() => request.signal.removeEventListener("abort", close)),
				)
				return yield* Effect.gen(function* () {
					if (!["GET", "HEAD", "POST", "DELETE"].includes(request.method))
						return yield* Network.NetworkError.make({
							reason: "Transport",
							message: "Unsupported SDK HTTP method",
						})
					let outgoing =
						request.method === "GET"
							? HttpClientRequest.get(request.url)
							: request.method === "HEAD"
								? HttpClientRequest.head(request.url)
								: request.method === "DELETE"
									? HttpClientRequest.make("DELETE")(request.url)
									: HttpClientRequest.post(request.url)
					outgoing = HttpClientRequest.setHeaders(
						outgoing,
						Rec.fromEntries(request.headers),
					)
					if (request.body !== null) {
						const bytes = yield* Effect.tryPromise({
							try: () => request.arrayBuffer(),
							catch: (cause) =>
								Network.NetworkError.make({
									reason: "Transport",
									message: "Could not read SDK request body",
									cause,
								}),
						})
						outgoing = HttpClientRequest.bodyUint8Array(
							outgoing,
							new Uint8Array(bytes),
							request.headers.get("content-type") ?? undefined,
						)
					}
					if (options.documents === true && request.method === "GET") {
						const reply = yield* network.readDocument({
							url: request.url,
							headers: Rec.fromEntries(request.headers),
						})
						yield* Scope.close(scope, Exit.void)
						return new Response(
							[204, 205, 304].includes(reply.status) ? null : reply.text,
							{
								status: reply.status,
								headers: decodedHeaders(reply.headers),
							},
						)
					}
					const reply = yield* network.execute(outgoing)
					const headers = decodedHeaders(reply.headers)
					if (
						request.method === "HEAD" ||
						[204, 205, 304].includes(reply.status)
					) {
						yield* Scope.close(scope, Exit.void)
						return new Response(null, {
							status: reply.status,
							headers,
						})
					}
					if (options.documents === true) {
						const text = yield* HttpNetwork.readBounded({
							reply,
							maxBytes: 1048576,
						})
						yield* Scope.close(scope, Exit.void)
						return new Response(text, {
							status: reply.status,
							headers,
						})
					}
					// The SDK reads a whole JSON body, and each whole SSE event, into memory.
					const body = yield* Stream.toReadableStreamEffect(
						reply.body.pipe(
							mediaType(reply.headers) === "text/event-stream"
								? HttpNetwork.eventLimit(maxMessageBytes)
								: HttpNetwork.limit(maxMessageBytes),
							Stream.ensuring(Scope.close(scope, Exit.void)),
						),
					)
					return new Response(body, {
						status: reply.status,
						headers,
					})
				}).pipe(
					Effect.provideService(Scope.Scope, scope),
					(effect) =>
						options.documents === true
							? effect.pipe(
									Effect.timeoutOrElse({
										duration: 10_000,
										orElse: () =>
											Effect.fail(
												Network.NetworkError.make({
													reason: "Timeout",
													message: "OAuth response timed out",
												}),
											),
									}),
								)
							: effect,
					Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
				)
			}),
			{ signal: request.signal },
		)
	}
	return callback
})
