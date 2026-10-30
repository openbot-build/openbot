import { assert, it } from "@effect/vitest"
// The test runs a real local SMTP peer and observes its socket.
import { createServer, type Socket } from "node:net"
// Only this test worker trusts the local SMTP peer's test certificate.
import {
	createServer as createTlsServer,
	getCACertificates,
	setDefaultCACertificates,
} from "node:tls"
import {
	Array as Arr,
	Effect,
	Fiber,
	Option,
	Redacted,
	String as Str,
} from "effect"
import { TestClock } from "effect/testing"
import * as Smtp from "../src/mail/Smtp.ts"
import { Transport, type Message } from "../src/mail/Transport.ts"

const message: Message = {
	from: { address: "openbot@example.com", name: "OpenBot" },
	to: "person@example.com",
	subject: "Private test subject",
	html: "<p>Private test body</p>",
	text: "Private test body",
}

// A public test key and self-signed certificate for 127.0.0.1, valid through 2126.
const testKey = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgHIJ5EAalLwiMFNAT
Jkd2fMdzBrp4yk/lXp2f4ycCOg+hRANCAARpS0dEy2y83ISnTnbUPSD/d5G/0zVc
V05utDDlyxWGvT9SXP3yazxM32GejhR5kABvXDUg5lsiO0vl6CBSa9DR
-----END PRIVATE KEY-----`
const testCertificate = `-----BEGIN CERTIFICATE-----
MIIBjzCCATagAwIBAgIUKK0+CSQeS/4Eq6dLQpIUNDDm43IwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MTAyOTEwMzIxN1oYDzIxMjYxMDA1
MTAzMjE3WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAARpS0dEy2y83ISnTnbUPSD/d5G/0zVcV05utDDlyxWGvT9SXP3yazxM
32GejhR5kABvXDUg5lsiO0vl6CBSa9DRo2QwYjAdBgNVHQ4EFgQUjsVeEBtvFEQD
MbO+gWeph8q1LeYwHwYDVR0jBBgwFoAUjsVeEBtvFEQDMbO+gWeph8q1LeYwDwYD
VR0RBAgwBocEfwAAATAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQC
IAl7ISkE8QYeroMeCsx8by3J+IiNB2JDOHazrTzHcS0pAiAsD1BJZ8ypsheBJ0fy
JKV+6AwipUVbp06mvYVsjW4IlA==
-----END CERTIFICATE-----`

/** A real peer that either refuses mail, refuses TLS, or stops answering. */
const peer = Effect.fn("MailSmtp.peer")(function* (
	mode: "refuse" | "no-tls" | "hold",
) {
	let attempts = 0
	let received = ""
	let hello = false
	let closed = false
	let sockets: ReadonlyArray<Socket> = []
	const server = yield* Effect.acquireRelease(
		Effect.sync(() =>
			createServer((socket) => {
				attempts += 1
				sockets = Arr.append(sockets, socket)
				if (mode === "refuse") socket.end("421 Please try later\r\n")
				else socket.write("220 test.example ESMTP\r\n")
				let buffer = ""
				socket.on("data", (data: Buffer) => {
					received += data.toString()
					buffer += data.toString()
					while (Str.includes("\r\n")(buffer)) {
						const end = Option.getOrElse(
							Str.indexOf("\r\n")(buffer),
							() => buffer.length,
						)
						const command = Str.slice(0, end)(buffer)
						buffer = Str.slice(end + 2)(buffer)
						if (Str.startsWith("EHLO ")(command)) {
							hello = true
							server.emit("smtp-hello")
							if (mode === "no-tls")
								socket.write("250-test.example\r\n250 AUTH PLAIN LOGIN\r\n")
						} else if (command === "STARTTLS") {
							socket.write("502 TLS is not available\r\n")
						}
					}
				})
				socket.on("close", () => {
					closed = true
					server.emit("smtp-closed")
				})
			}),
		),
		(server) =>
			Effect.callback<void>((resume) => {
				for (const socket of sockets) socket.destroy()
				server.close(() => resume(Effect.void))
			}),
	)
	yield* Effect.callback<void>((resume) => {
		server.listen(0, "127.0.0.1", () => resume(Effect.void))
	})
	const address = server.address()
	assert.ok(address !== null && typeof address !== "string")
	const wait = (event: string, done: () => boolean) =>
		Effect.callback<void>((resume) => {
			if (done()) return resume(Effect.void)
			const finish = () => resume(Effect.void)
			server.once(event, finish)
			return Effect.sync(() => {
				server.removeListener(event, finish)
			})
		})
	return {
		connection: {
			host: "127.0.0.1",
			port: address.port,
			security: "starttls" as const,
			username: "private-login",
			password: Redacted.make("private-password"),
		},
		attempts: () => attempts,
		received: () => received,
		waitHello: wait("smtp-hello", () => hello),
		waitClosed: wait("smtp-closed", () => closed),
	}
})

it.effect("SMTP has a total time limit inside an uninterruptible request", () =>
	Effect.gen(function* () {
		const remote = yield* peer("hold")
		const transport = yield* Transport
		const sending = yield* transport
			.send(remote.connection, message)
			.pipe(Effect.result, Effect.uninterruptible, Effect.forkScoped)
		yield* remote.waitHello
		yield* TestClock.adjust("30 seconds")
		const result = yield* Fiber.join(sending)
		assert.strictEqual(result._tag, "Failure")
		if (result._tag === "Failure") {
			assert.strictEqual(result.failure._tag, "MailTransportError")
			assert.strictEqual(
				result.failure.cause,
				"The SMTP send did not finish within 30 seconds.",
			)
		}
		yield* remote.waitClosed
		assert.strictEqual(remote.attempts(), 1)
	}).pipe(Effect.provide(Smtp.layer)),
)

it.layer(Smtp.layer, { excludeTestServices: true })((it) => {
	it.effect(
		"SMTP logs in over verified TLS and sends one HTML and text email",
		() =>
			Effect.gen(function* () {
				yield* Effect.acquireRelease(
					Effect.sync(() => {
						const previous = getCACertificates("default")
						setDefaultCACertificates([...previous, testCertificate])
						return previous
					}),
					(previous) => Effect.sync(() => setDefaultCACertificates(previous)),
				)
				let attempts = 0
				let login = ""
				let envelope: ReadonlyArray<string> = []
				let body = ""
				let accepted = 0
				let sockets: ReadonlyArray<Socket> = []
				const server = yield* Effect.acquireRelease(
					Effect.sync(() =>
						createTlsServer(
							{ key: testKey, cert: testCertificate },
							(socket) => {
								attempts += 1
								sockets = Arr.append(sockets, socket)
								socket.write("220 test.example ESMTP\r\n")
								let buffer = ""
								let data = false
								socket.on("data", (chunk: Buffer) => {
									buffer += chunk.toString()
									while (Str.includes("\r\n")(buffer)) {
										const end = Option.getOrElse(
											Str.indexOf("\r\n")(buffer),
											() => buffer.length,
										)
										const command = Str.slice(0, end)(buffer)
										buffer = Str.slice(end + 2)(buffer)
										if (data) {
											if (command === ".") {
												data = false
												accepted += 1
												socket.write("250 Accepted\r\n")
											} else body += command + "\r\n"
										} else if (Str.startsWith("EHLO ")(command)) {
											socket.write("250-test.example\r\n250 AUTH PLAIN\r\n")
										} else if (Str.startsWith("AUTH PLAIN ")(command)) {
											login = Buffer.from(
												Str.slice(11)(command),
												"base64",
											).toString()
											socket.write(
												login === "\0private-login\0private-password"
													? "235 Logged in\r\n"
													: "535 Bad login\r\n",
											)
										} else if (/^(MAIL FROM|RCPT TO):/.test(command)) {
											envelope = Arr.append(envelope, command)
											socket.write("250 OK\r\n")
										} else if (command === "DATA") {
											data = true
											socket.write("354 Send the message\r\n")
										}
									}
								})
							},
						),
					),
					(server) =>
						Effect.callback<void>((resume) => {
							for (const socket of sockets) socket.destroy()
							server.close(() => resume(Effect.void))
						}),
				)
				yield* Effect.callback<void>((resume) => {
					server.listen(0, "127.0.0.1", () => resume(Effect.void))
				})
				const address = server.address()
				assert.ok(address !== null && typeof address !== "string")
				const transport = yield* Transport
				yield* transport.send(
					{
						host: "127.0.0.1",
						port: address.port,
						security: "tls",
						username: "private-login",
						password: Redacted.make("private-password"),
					},
					message,
				)
				assert.strictEqual(attempts, 1)
				assert.strictEqual(accepted, 1)
				assert.strictEqual(login, "\0private-login\0private-password")
				assert.deepStrictEqual(envelope, [
					"MAIL FROM:<openbot@example.com>",
					"RCPT TO:<person@example.com>",
				])
				assert.include(body, "Subject: Private test subject\r\n")
				assert.include(body, "To: person@example.com\r\n")
				assert.include(body, "multipart/alternative")
				assert.include(body, "Content-Type: text/plain")
				assert.include(body, "Content-Type: text/html")
				assert.include(body, "<p>Private test body</p>")
			}),
	)
	it.effect(
		"SMTP does not send credentials or mail when STARTTLS is refused",
		() =>
			Effect.gen(function* () {
				const remote = yield* peer("no-tls")
				const transport = yield* Transport
				const error = yield* transport
					.send(remote.connection, message)
					.pipe(Effect.flip)
				assert.strictEqual(error._tag, "MailTransportError")
				assert.strictEqual(remote.attempts(), 1)
				assert.include(remote.received(), "STARTTLS\r\n")
				assert.notMatch(
					remote.received(),
					/AUTH|MAIL FROM|RCPT TO|DATA|private-|Private test/,
				)
			}),
	)

	it.effect("SMTP reports a refused greeting without a second send", () =>
		Effect.gen(function* () {
			const remote = yield* peer("refuse")
			const transport = yield* Transport
			const error = yield* transport
				.send(remote.connection, message)
				.pipe(Effect.flip)
			assert.strictEqual(error._tag, "MailTransportError")
			assert.strictEqual(remote.attempts(), 1)
			assert.strictEqual(remote.received(), "")
		}),
	)

	it.effect("stopping a send closes the active SMTP socket", () =>
		Effect.gen(function* () {
			const remote = yield* peer("hold")
			const transport = yield* Transport
			const sending = yield* transport
				.send(remote.connection, message)
				.pipe(Effect.forkScoped)
			yield* remote.waitHello
			yield* Fiber.interrupt(sending)
			yield* remote.waitClosed.pipe(Effect.timeout("1 second"))
			assert.strictEqual(remote.attempts(), 1)
			assert.notMatch(remote.received(), /AUTH|MAIL FROM|DATA/)
		}),
	)
})
