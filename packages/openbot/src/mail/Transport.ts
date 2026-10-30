import { Context, type Effect, type Redacted, Schema } from "effect"

/** SMTP settings for one send. The password stays redacted until the adapter uses it. */
export interface Connection {
	readonly host: string
	readonly port: number
	readonly security: "tls" | "starttls"
	readonly username: string | null
	readonly password: Redacted.Redacted<string> | null
}

export interface Message {
	readonly from: { readonly address: string; readonly name: string }
	readonly to: string
	readonly subject: string
	readonly html: string
	readonly text: string
}

export class TransportError extends Schema.TaggedError<
	TransportError,
	{ readonly brand: unique symbol }
>()("MailTransportError", { cause: Schema.Defect() }) {}

/** The outside service that accepts a mail message. It must not retry a send. */
export class Transport extends Context.Service<
	Transport,
	{
		readonly send: (
			connection: Connection,
			message: Message,
		) => Effect.Effect<void, TransportError>
	}
>()("@openbot-build/openbot/mail/Transport") {}
