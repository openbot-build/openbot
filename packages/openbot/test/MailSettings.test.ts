import { assert, it } from "@effect/vitest"
import { NodeCrypto } from "@effect/platform-node"
import { Authorization, Settings as Model } from "@openbot-build/domain"
import { Effect, Redacted, Schema, String as Str } from "effect"
import * as Secrets from "../src/secrets/Secrets.ts"
import { PlatformDocument } from "../src/settings/Documents.ts"
import { bindings, changeMail } from "../src/settings/Platform.ts"
import * as Views from "../src/settings/Views.ts"

const fields = {
	host: "smtp.example.com",
	port: 587,
	security: "starttls" as const,
	from: "openbot@example.com",
	fromName: "OpenBot",
	username: "openbot",
	invitationUrl: "https://app.example.com/invitations",
}
const document: PlatformDocument = {
	publicOrigin: "https://app.example.com",
	authSecret: "sealed",
	identityProvider: null,
	organizationCreation: "anyone",
	ceiling: Authorization.emptyPolicy,
	appRestrictions: [],
}

it.effect("mail settings reject bad addresses and insecure links", () =>
	Effect.gen(function* () {
		const input = { ...fields, password: "test password" }
		for (const change of [
			{ host: "smtp.example.com:587" },
			{ host: "https://smtp.example.com" },
			{ host: "smtp.example.com/path" },
			{ host: "smtp.example.com\r\nother" },
			{ host: "bad..example.com" },
			{ port: 0 },
			{ port: 65536 },
			{ security: "none" },
			{ fromName: "OpenBot\r\nBcc: other@example.com" },
			{ username: "openbot\nother" },
			{ from: "bad address" },
			{ invitationUrl: "http://app.example.com/invitations" },
			{ invitationUrl: "https://user:pass@app.example.com" },
			{ invitationUrl: "javascript:alert(1)" },
			{ invitationUrl: "https://app.example.com/\u0000" },
		]) {
			const result = yield* Schema.decodeUnknownEffect(Model.MailInput)({
				...input,
				...change,
			}).pipe(Effect.result)
			assert.strictEqual(result._tag, "Failure")
		}
		for (const host of [
			"smtp.example.com",
			"localhost",
			"127.0.0.1",
			"::1",
			"2001:db8::1",
		])
			yield* Schema.decodeEffect(Model.MailInput)({ ...input, host })
		yield* Schema.decodeEffect(Model.MailInput)({
			...input,
			invitationUrl: "http://openbot.localhost/invitations?tab=all",
		})
	}),
)

it.effect("old settings keep mail off without a data change", () =>
	Effect.gen(function* () {
		const encoded = yield* Schema.encodeEffect(PlatformDocument)(document)
		const decoded = yield* Schema.decodeEffect(PlatformDocument)(encoded)
		const publicSettings = Views.platform({
			document: decoded,
			version: 1,
			updatedAt: 0,
		})
		assert.strictEqual(publicSettings.mail, null)
		yield* Schema.encodeEffect(Model.PlatformSettings)(publicSettings)
	}),
)

it.layer(NodeCrypto.layer)((it) => {
	it.effect(
		"SMTP passwords are sealed and API views hide every character",
		() =>
			Effect.gen(function* () {
				const secrets = yield* Secrets.make(
					Redacted.make("test:" + Str.repeat(32)("11")),
				)
				const mail = yield* changeMail(secrets, null, {
					...fields,
					password: Redacted.make("long secret password"),
				})
				assert.ok(mail !== null && mail.password !== null)
				assert.notStrictEqual(mail.password, "long secret password")
				assert.strictEqual(
					yield* secrets.open(mail.password, bindings.mailPassword),
					"long secret password",
				)
				assert.strictEqual(
					(yield* secrets
						.open(mail.password, bindings.authSecret)
						.pipe(Effect.result))._tag,
					"Failure",
				)
				const view = Views.platform({
					document: { ...document, mail },
					version: 2,
					updatedAt: 0,
				})
				assert.deepStrictEqual(view.mail?.password, { set: true, hint: null })
				const kept = yield* changeMail(secrets, mail, {
					...fields,
					fromName: "OpenBot Team",
				})
				assert.strictEqual(kept?.password, mail.password)
				const changed = yield* changeMail(secrets, mail, {
					...fields,
					password: Redacted.make("changed secret"),
				})
				assert.ok(changed !== null && changed.password !== null)
				assert.strictEqual(
					yield* secrets.open(changed.password, bindings.mailPassword),
					"changed secret",
				)
			}),
	)
	it.effect("new servers and logins cannot reuse a stored SMTP password", () =>
		Effect.gen(function* () {
			const secrets = yield* Secrets.make(
				Redacted.make("test:" + Str.repeat(32)("11")),
			)
			const mail = yield* changeMail(secrets, null, {
				...fields,
				password: Redacted.make("secret"),
			})
			for (const change of [
				{ host: "other.example.com" },
				{ port: 465 },
				{ security: "tls" as const },
				{ username: "other" },
				{ password: null },
			]) {
				const failed = yield* changeMail(secrets, mail, {
					...fields,
					...change,
				}).pipe(Effect.flip)
				assert.strictEqual(failed._tag, "SettingsInvalid")
			}
			assert.strictEqual(
				(yield* changeMail(secrets, null, fields).pipe(Effect.flip))._tag,
				"SettingsInvalid",
			)
			const cleared = yield* changeMail(secrets, mail, {
				...fields,
				username: null,
			})
			assert.deepStrictEqual(cleared, {
				...fields,
				username: null,
				password: null,
			})
			assert.deepStrictEqual(
				yield* changeMail(secrets, null, {
					...fields,
					username: null,
					password: null,
				}),
				{ ...fields, username: null, password: null },
			)
			assert.strictEqual(yield* changeMail(secrets, mail, null), null)
		}),
	)
})
