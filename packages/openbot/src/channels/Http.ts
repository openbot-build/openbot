import { Network } from "@openbot-build/protocol/Network"
import { Effect, Layer, Stream } from "effect"
import { type HttpClient, type HttpClientRequest } from "effect/http"
import { ChannelDeliveryFailed } from "./Channel.ts"

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

const parse = (text: string): unknown => {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

const unreachable = (cause: unknown) =>
	new ChannelDeliveryFailed({
		message: `The platform could not be reached: ${String(cause)}`,
		retry: true,
	})

const timedOut = () =>
	Effect.fail(
		new ChannelDeliveryFailed({
			message: "The platform did not answer in time",
			retry: true,
		}),
	)

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
			Effect.mapError(unreachable),
			Effect.timeoutOrElse({ duration: timeoutMs, orElse: timedOut }),
		)

/**
 * Calls an address that an administrator chose, such as the endpoint of a custom Channel.
 * The network only reaches public addresses, so a Channel cannot call into the server's
 * own network.
 */
export const fromNetwork =
	(network: Layer.Layer<Network>): Call =>
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
			// @effect-diagnostics-next-line strictEffectProvide:off
			Effect.provide(network),
			Effect.mapError(unreachable),
			Effect.timeoutOrElse({ duration: timeoutMs, orElse: timedOut }),
		)

/** Turns a failed HTTP answer into a delivery failure, with the wait that the platform asked for. */
export const failed = (reply: Reply, message: string) => {
	const after = Number(reply.headers["retry-after"])
	return new ChannelDeliveryFailed({
		message,
		retry: reply.status === 429 || reply.status >= 500,
		...(reply.status === 429 && Number.isFinite(after)
			? { retryAfterMs: after * 1000 }
			: {}),
	})
}
