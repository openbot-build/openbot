import { assert, it } from "@effect/vitest"
import { Authorization, Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Effect,
	Layer,
	Option,
	Redacted,
	Ref,
	String as Str,
} from "effect"
import * as Mail from "../src/mail/Mail.ts"
import {
	Transport,
	TransportError,
	type Connection,
	type Message,
} from "../src/mail/Transport.ts"
import { Settings } from "../src/settings/Settings.ts"
import type { PlatformDocument } from "../src/settings/Documents.ts"
import { Secrets } from "../src/secrets/Secrets.ts"
import { bindings } from "../src/settings/Platform.ts"
import { Records } from "../src/errors/Records.ts"

const document: PlatformDocument = {
	publicOrigin: "https://openbot.example.com",
	authSecret: "unused",
	identityProvider: null,
	organizationCreation: "anyone",
	ceiling: Authorization.emptyPolicy,
	appRestrictions: [],
}
const mail = {
	host: "smtp.example.com",
	port: 587,
	security: "starttls" as const,
	from: "openbot@example.com",
	fromName: "OpenBot",
	username: "sender",
	password: "sealed-password",
	invitationUrl: null,
}
const invitation: Mail.Invitation = {
	id: "inv_test",
	email: "person@example.com",
	organizationName: "Example Team",
	expiresAt: 1804032000000,
}

const fixture = Effect.gen(function* () {
	const current = yield* Ref.make(document)
	const sends = yield* Ref.make<
		ReadonlyArray<{ connection: Connection; message: Message }>
	>([])
	const failed = yield* Ref.make(false)
	const reports = yield* Ref.make(0)
	const opened = yield* Ref.make(0)
	const layer = Mail.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.mock(Settings, {
					platform: Ref.get(current).pipe(
						Effect.map((document) =>
							Option.some({ document, version: 1, updatedAt: 0 }),
						),
					),
				}),
				Layer.mock(Secrets, {
					open: (value, binding) =>
						Effect.gen(function* () {
							assert.strictEqual(value, "sealed-password")
							assert.strictEqual(binding, bindings.mailPassword)
							yield* Ref.update(opened, (n) => n + 1)
							return "smtp password"
						}),
				}),
				Layer.succeed(Transport, {
					send: (connection, message) =>
						Effect.gen(function* () {
							yield* Ref.update(sends, Arr.append({ connection, message }))
							if (yield* Ref.get(failed))
								return yield* TransportError.make({
									cause: "The SMTP server refused the message.",
								})
						}),
				}),
				Layer.succeed(Records, {
					record: () =>
						Ref.update(reports, (n) => n + 1).pipe(
							Effect.as({
								errorId: Execution.ErrorId.make("mail-test-error"),
								category: "unavailable" as const,
							}),
						),
				}),
			),
		),
	)
	return { current, sends, failed, reports, opened, layer }
})

it.effect(
	"mail reads settings for each send and opens the password only when enabled",
	() =>
		Effect.gen(function* () {
			const test = yield* fixture
			yield* Effect.gen(function* () {
				const service = yield* Mail.Mail
				assert.deepStrictEqual(yield* service.invitation(invitation), {
					status: "disabled",
				})
				assert.deepStrictEqual(yield* Ref.get(test.sends), [])
				assert.strictEqual(yield* Ref.get(test.opened), 0)
				yield* Ref.set(test.current, { ...document, mail })
				assert.deepStrictEqual(yield* service.invitation(invitation), {
					status: "sent",
				})
				const first = (yield* Ref.get(test.sends))[0]!
				assert.strictEqual(first.message.to, invitation.email)
				assert.deepStrictEqual(first.message.from, {
					address: mail.from,
					name: mail.fromName,
				})
				assert.ok(
					Str.includes(
						document.publicOrigin + "/invitations?invitation=inv_test",
					)(first.message.html),
				)
				assert.ok(Str.includes(invitation.organizationName)(first.message.text))
				assert.ok(Str.includes("3 March 2027")(first.message.text))
				assert.ok(Str.includes("UTC")(first.message.text))
				assert.ok(first.connection.password !== null)
				assert.strictEqual(
					Redacted.value(first.connection.password),
					"smtp password",
				)
				yield* Ref.set(test.current, {
					...document,
					mail: {
						...mail,
						username: null,
						password: null,
						host: "smtp2.example.com",
						invitationUrl: "https://app.example.com/inbox",
					},
				})
				assert.deepStrictEqual(yield* service.test("admin@example.com"), {
					status: "sent",
				})
				const second = (yield* Ref.get(test.sends))[1]!
				assert.strictEqual(second.connection.host, "smtp2.example.com")
				assert.strictEqual(second.connection.password, null)
				assert.ok(
					Str.includes("https://app.example.com/inbox")(second.message.html),
				)
				assert.strictEqual(yield* Ref.get(test.opened), 1)
				yield* Ref.set(test.current, { ...document, mail: null })
				assert.deepStrictEqual(yield* service.test("admin@example.com"), {
					status: "disabled",
				})
				assert.strictEqual((yield* Ref.get(test.sends)).length, 2)
			}).pipe(Effect.provide(test.layer))
		}),
)

it.effect(
	"a failed mail send keeps its cause and makes no automatic retry",
	() =>
		Effect.gen(function* () {
			const test = yield* fixture
			yield* Ref.set(test.current, { ...document, mail })
			yield* Ref.set(test.failed, true)
			yield* Effect.gen(function* () {
				const service = yield* Mail.Mail
				assert.deepStrictEqual(
					yield* service.invitation({ ...invitation, botName: "Helper" }),
					{ status: "failed" },
				)
				assert.strictEqual((yield* Ref.get(test.sends)).length, 1)
				assert.strictEqual(yield* Ref.get(test.reports), 1)
				yield* Ref.set(test.failed, false)
				assert.deepStrictEqual(yield* service.invitation(invitation), {
					status: "sent",
				})
				assert.strictEqual((yield* Ref.get(test.sends)).length, 2)
			}).pipe(Effect.provide(test.layer))
		}),
)
