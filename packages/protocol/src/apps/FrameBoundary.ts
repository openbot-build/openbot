import {
	specTypeSchemas,
	type JSONRPCMessage,
	type Transport,
} from "@modelcontextprotocol/client"

export const decodeMessage = async (
	value: unknown,
): Promise<JSONRPCMessage | undefined> => {
	const parsed = specTypeSchemas.JSONRPCMessage["~standard"].validate(value)
	return parsed.issues === undefined ? parsed.value : undefined
}

/** The host-side transport has an exact target origin, source Window and instance lifetime. */
export class FrameTransport implements Transport {
	public onclose?: () => void
	public onerror?: (error: Error) => void
	public onmessage?: Transport["onmessage"]
	private closed = false
	private listener: ((event: MessageEvent) => void) | undefined
	public constructor(
		private readonly peer: Window,
		private readonly origin: string,
	) {}
	public async start(): Promise<void> {
		this.listener = (event) => {
			if (
				this.closed ||
				!event.isTrusted ||
				event.source !== this.peer ||
				event.origin !== this.origin
			)
				return
			void decodeMessage(event.data)
				.then((message) => {
					if (!this.closed && message !== undefined) this.onmessage?.(message)
				})
				.catch(() => this.onerror?.(new Error("Invalid Apps message")))
		}
		window.addEventListener("message", this.listener)
	}
	public async send(message: JSONRPCMessage): Promise<void> {
		if (this.closed) throw new Error("Apps transport closed")
		this.peer.postMessage(message, this.origin)
	}
	public async close(): Promise<void> {
		if (this.closed) return
		this.closed = true
		if (this.listener !== undefined)
			window.removeEventListener("message", this.listener)
		this.onclose?.()
	}
}
