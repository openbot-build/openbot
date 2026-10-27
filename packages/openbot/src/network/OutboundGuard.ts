import { Network } from "@openbot-build/protocol"
import type { Resolver } from "@openbot-build/protocol/Node"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { Effect, FiberSet, Layer, pipe, Schema, String as Str } from "effect"
import { isIP } from "node:net"
// Node does not export `setGlobalDispatcher`. The `undici` package sets the
// same global dispatcher that Node's own `fetch` reads.
import {
	Agent,
	buildConnector,
	getGlobalDispatcher,
	setGlobalDispatcher,
} from "undici"
import { OutboundPolicy, make, type Allow } from "./OutboundPolicy.ts"

/** The error that `fetch` gives as its cause when the guard blocks a target. */
export class OutboundBlocked extends Schema.TaggedError<
	OutboundBlocked,
	{ readonly brand: unique symbol }
>()("OutboundBlocked", { hostname: Schema.String }) {
	readonly reason = "BlockedTarget"
	override get message() {
		return `OpenBot blocked an outbound connection to ${this.hostname}, because it is not a public address. To allow it, add the host to OPENBOT_OUTBOUND_ALLOW.`
	}
}

const isNetworkError = Schema.is(Network.NetworkError)

/**
 * Builds a dispatcher that checks every new socket. Node skips the DNS lookup
 * for an IP literal, so the connector checks literals itself.
 */
export const dispatcher = (options: {
	readonly allowAddress: (address: string, hostname: string) => boolean
	readonly lookup?: Resolver
	readonly onBlocked?: (hostname: string) => void
}) => {
	const connect = buildConnector({
		lookup: NodeHttpServer.guardedLookup(options.allowAddress, options.lookup),
	})
	return new Agent({
		connect: (target, callback) => {
			const hostname = pipe(target.hostname, Str.replace(/^\[|\]$/g, ""))
			const blocked = () => {
				options.onBlocked?.(hostname)
				callback(OutboundBlocked.make({ hostname }), null)
			}
			if (isIP(hostname) !== 0 && !options.allowAddress(hostname, hostname)) {
				blocked()
				return
			}
			connect(target, (error, socket) => {
				if (error === null) callback(null, socket)
				else if (isNetworkError(error) && error.reason === "BlockedTarget")
					blocked()
				else callback(error, null)
			})
		},
	})
}

/**
 * Sets the address rule for the whole process. Every `fetch` then checks each
 * socket, also on redirects, and the App networks use the same rule.
 * The old global dispatcher comes back when the scope closes.
 */
export const layer = (allow: Allow) => {
	const policy = make(allow)
	return Layer.effectDiscard(
		Effect.gen(function* () {
			const callbacks = yield* FiberSet.make()
			const run = yield* FiberSet.runtime(callbacks)<never>()
			const warn = (hostname: string) =>
				run(
					// Effect 4.0.6 registers runtime fibers after they start. Yield before logging.
					Effect.andThen(
						Effect.yieldNow,
						Effect.logWarning("Blocked an outbound connection"),
					).pipe(Effect.annotateLogs({ hostname })),
				)
			yield* Effect.acquireRelease(
				Effect.sync(() => {
					const previous = getGlobalDispatcher()
					const guarded = dispatcher({
						allowAddress: policy.allowAddress,
						onBlocked: warn,
					})
					setGlobalDispatcher(guarded)
					return { previous, guarded }
				}),
				({ previous, guarded }) =>
					Effect.sync(() => setGlobalDispatcher(previous)).pipe(
						// A dispatcher that cannot close must not stop the shut down.
						Effect.andThen(
							Effect.tryPromise(() => guarded.close()).pipe(
								Effect.ignore({ log: "Debug" }),
							),
						),
					),
			)
		}),
	).pipe(Layer.provideMerge(Layer.succeed(OutboundPolicy, policy)))
}
