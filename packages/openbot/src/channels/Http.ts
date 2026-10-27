import { Network } from "@openbot-build/protocol/Network"
import { Array as Arr, type Context, Effect, Stream } from "effect"
import { type HttpClient, type HttpClientRequest } from "effect/http"
import { ChannelDeliveryFailed } from "./Channel.ts"
import { parse } from "./Json.ts"

export interface Reply {
	readonly status: number
	readonly headers: Readonly<Record<string, string | undefined>>
	/** The JSON body, or `undefined` when the body is not JSON. */
	readonly json: unknown
}

/** Sends one request to a platform and reads its answer. */
export type Call = (
	request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<Reply, ChannelDeliveryFailed>

const timeoutMs = 15_000

/** Calls a platform with a fixed address, such as slack.com. */
export const fromClient =
	(client: HttpClient.HttpClient): Call =>
	(request) =>
		client.execute(request).pipe(
			Effect.flatMap((response) =>
				response.text.pipe(
					Effect.map((text): Reply => ({
						status: response.status,
						headers: response.headers,
						json: parse(text),
					})),
				),
			),
			Effect.catchTag("HttpClientError", (error) =>
				Effect.fail(
					ChannelDeliveryFailed.make({
						// The address of some platforms holds a secret, such as the bot token of
						// Telegram. The text of an HttpClientError has the full address, so only
						// the kind of failure and the host go in the message, and only the cause
						// of the reason (such as the fetch failure) goes in the cause.
						message: `The platform could not be reached: ${error.reason._tag} (${URL.parse(error.request.url)?.host ?? "unknown host"})`,
						retry: true,
						cause: error.reason.cause,
					}),
				),
			),
			Effect.timeoutOrElse({
				duration: timeoutMs,
				orElse: () =>
					Effect.fail(
						ChannelDeliveryFailed.make({
							message: "The platform did not answer in time",
							retry: true,
						}),
					),
			}),
		)

/**
 * Calls an address that an administrator chose, such as the endpoint of a custom Channel.
 * The network only reaches public addresses, so a Channel cannot call into the server's
 * own network.
 */
export const fromNetwork =
	(network: Context.Context<Network>): Call =>
	(request) =>
		Effect.scoped(
			Effect.gen(function* () {
				const net = yield* Network
				const reply = yield* net.execute(request)
				const text = yield* reply.body.pipe(
					Stream.decodeText(),
					Stream.mkString,
				)
				return {
					status: reply.status,
					headers: reply.headers,
					json: parse(text),
				} satisfies Reply
			}),
		).pipe(
			// Each custom Channel has its own guarded network, made for its endpoint.
			Effect.provideContext(network),
			Effect.catchTags({
				NetworkError: (error) =>
					Effect.fail(
						ChannelDeliveryFailed.make({
							message: `The custom Channel could not be reached: ${error.reason}: ${error.message}`,
							// A blocked address, a redirect or an unknown encoding is the same on the next try.
							retry: error.reason === "Transport" || error.reason === "Timeout",
							cause: error,
						}),
					),
				SchemaError: (error) =>
					Effect.fail(
						ChannelDeliveryFailed.make({
							message: "The address of the custom Channel is not valid",
							retry: false,
							cause: error,
						}),
					),
			}),
			Effect.timeoutOrElse({
				duration: timeoutMs,
				orElse: () =>
					Effect.fail(
						ChannelDeliveryFailed.make({
							message: "The platform did not answer in time",
							retry: true,
						}),
					),
			}),
		)

/** Turns a failed HTTP answer into a delivery failure, with the wait that the platform asked for. */
export const failed = (reply: Reply, message: string) => {
	const after = Number(reply.headers["retry-after"])
	return ChannelDeliveryFailed.make({
		message,
		retry: reply.status === 429 || reply.status >= 500,
		...(Arr.contains([400, 401, 403, 404, 422, 429], reply.status)
			? { outcome: "rejected" as const }
			: {}),
		...(reply.status === 429 && Number.isFinite(after)
			? { retryAfterMs: after * 1000 }
			: {}),
	})
}
