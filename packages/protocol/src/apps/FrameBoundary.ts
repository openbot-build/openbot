import {
	specTypeSchemas,
	type JSONRPCMessage,
	type Transport,
} from "@modelcontextprotocol/client"
import { Option } from "effect"

/** The SDK schema is synchronous, so a message is checked at once. */
export const decodeMessage = (
	value: unknown,
): Option.Option<JSONRPCMessage> => {
	const parsed = specTypeSchemas.JSONRPCMessage["~standard"].validate(value)
	return parsed.issues === undefined ? Option.some(parsed.value) : Option.none()
}

/** The host-side transport has an exact target origin, source Window and instance lifetime. */
export class FrameTransport implements Transport {
	public onclose?: () => void
	public onerror?: (error: Error) => void
	public onmessage?: Transport["onmessage"]
	private closed = false
	private readonly listener = (event: MessageEvent) => {
		if (
			this.closed ||
			!event.isTrusted ||
			event.source !== this.peer ||
			event.origin !== this.origin
		)
			return
		// The frame is not trusted, so the host drops a message that is not JSON-RPC.
		Option.match(decodeMessage(event.data), {
			onNone: () => undefined,
			onSome: (message) => this.onmessage?.(message),
		})
	}
	public constructor(
		private readonly peer: Window,
		private readonly origin: string,
	) {}
	public async start(): Promise<void> {
		window.addEventListener("message", this.listener)
	}
	public async send(message: JSONRPCMessage): Promise<void> {
		// The SDK Transport contract reports a failed send as a rejected Promise.
		if (this.closed) throw new Error("Apps transport closed")
		this.peer.postMessage(message, this.origin)
	}
	public async close(): Promise<void> {
		if (this.closed) return
		this.closed = true
		window.removeEventListener("message", this.listener)
		this.onclose?.()
	}
}
