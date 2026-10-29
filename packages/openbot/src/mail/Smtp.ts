import { Effect, Layer, Redacted } from "effect"
import MailComposer from "nodemailer/lib/mail-composer"
import SMTPConnection from "nodemailer/lib/smtp-connection"
import {
	Transport,
	TransportError,
	type Connection,
	type Message,
} from "./Transport.ts"

const send = Effect.fn("MailSmtp.send")(function* (
	settings: Connection,
	message: Message,
) {
	const body = yield* Effect.tryPromise({
		try: () =>
			new MailComposer({
				from: message.from,
				to: { address: message.to, name: "" },
				subject: message.subject,
				html: message.html,
				text: message.text,
				disableFileAccess: true,
				disableUrlAccess: true,
			})
				.compile()
				.build(),
		catch: (cause) => TransportError.make({ cause }),
	})
	yield* Effect.callback<void, TransportError>((resume) => {
		const connection = new SMTPConnection({
			host: settings.host,
			port: settings.port,
			secure: settings.security === "tls",
			requireTLS: settings.security === "starttls",
			connectionTimeout: 10_000,
			greetingTimeout: 10_000,
			socketTimeout: 20_000,
			dnsTimeout: 10_000,
		})
		// Native callbacks may report both a failed command and a closed socket.
		let ended = false
		const fail = (cause: unknown) => {
			if (ended) return
			ended = true
			connection.close()
			resume(Effect.fail(TransportError.make({ cause })))
		}
		const sendBody = () => {
			if (ended) return
			connection.send(
				{ from: message.from.address, to: [message.to] },
				body,
				(error, result) => {
					if (error !== null) return fail(error)
					if (ended) return
					if (result.accepted.length !== 1 || result.rejected.length !== 0)
						return fail("The SMTP server did not accept the recipient.")
					ended = true
					connection.close()
					resume(Effect.void)
				},
			)
		}
		connection.once("error", fail)
		connection.once("end", () =>
			fail("The SMTP connection closed before the send finished."),
		)
		connection.connect((error) => {
			if (error !== undefined) return fail(error)
			if (ended) return
			if (!connection.secure) return fail("The SMTP connection is not secure.")
			if (settings.username === null) return sendBody()
			if (settings.password === null)
				return fail("The SMTP login has no password.")
			connection.login(
				{ user: settings.username, pass: Redacted.value(settings.password) },
				(error) => {
					if (error !== undefined && error !== null) return fail(error)
					sendBody()
				},
			)
		})
		return Effect.sync(() => {
			ended = true
			// Nodemailer's non-pooled transport.close() does not stop an active send.
			// Own the SMTPConnection so cancellation and the total time limit close it.
			connection.close()
		})
	})
})

/** Each send owns one connection. A failed or uncertain send is never retried. */
export const layer = Layer.succeed(Transport, {
	send: (connection, message) =>
		send(connection, message).pipe(
			Effect.interruptible,
			Effect.timeoutOrElse({
				duration: "30 seconds",
				orElse: () =>
					Effect.fail(
						TransportError.make({
							cause: "The SMTP send did not finish within 30 seconds.",
						}),
					),
			}),
		),
})
