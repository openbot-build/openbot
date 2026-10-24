import { Network } from "@openbot-build/protocol"
import type { Resolver } from "@openbot-build/protocol/Node"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { Effect, Layer } from "effect"
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
export class OutboundBlocked extends Error {
	readonly reason = "BlockedTarget"
	readonly hostname: string
	constructor(hostname: string) {
		super(
			`OpenBot blocked an outbound connection to ${hostname}, because it is not a public address. To allow it, add the host to OPENBOT_OUTBOUND_ALLOW.`,
		)
		this.name = "OutboundBlocked"
		this.hostname = hostname
	}
}

const isBlocked = (error: unknown) =>
	error instanceof Network.NetworkError && error.reason === "BlockedTarget"

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
			const hostname = target.hostname.replace(/^\[|\]$/g, "")
			const blocked = () => {
				options.onBlocked?.(hostname)
				callback(new OutboundBlocked(hostname), null)
			}
			if (isIP(hostname) !== 0 && !options.allowAddress(hostname, hostname)) {
				blocked()
				return
			}
			connect(target, (error, socket) => {
				if (error === null) callback(null, socket)
				else if (isBlocked(error)) blocked()
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
			const context = yield* Effect.context()
			const warn = (hostname: string) =>
				Effect.runForkWith(context)(
					Effect.logWarning("Blocked an outbound connection").pipe(
						Effect.annotateLogs({ hostname }),
					),
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
							Effect.tryPromise(() => guarded.close()).pipe(Effect.ignore),
						),
					),
			)
		}),
	).pipe(Layer.provideMerge(Layer.succeed(OutboundPolicy, policy)))
}
