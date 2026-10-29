import { assert, layer } from "@effect/vitest"
import {
	Authorization,
	Mail,
	Settings as SettingsApi,
	UserTokensApi,
} from "@openbot-build/api"
import {
	Array as Arr,
	Effect,
	Layer,
	Redacted,
	Ref,
	String as Str,
} from "effect"
import {
	Transport,
	TransportError,
	type Connection,
	type Message,
} from "../src/mail/Transport.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import * as Policies from "./Policies.ts"

const publicOrigin = "https://api.example.com"
const fields = {
	host: "smtp.example.com",
	port: 587,
	security: "starttls",
	from: "openbot@example.com",
	fromName: "OpenBot",
	username: "openbot",
	invitationUrl: "https://app.example.com/invitations",
}

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"only platform admins can change SMTP settings and send test mail",
		() =>
			Effect.gen(function* () {
				const sent = yield* Ref.make<
					ReadonlyArray<{
						readonly connection: Connection
						readonly message: Message
					}>
				>([])
				const fail = yield* Ref.make(false)
				const host = yield* BrowserHost.start({
					publicOrigin,
					sharedDomain: false,
					platformAdmins: ["root@example.com"],
					mailTransport: Layer.succeed(Transport, {
						send: (connection, message) =>
							Effect.gen(function* () {
								if (yield* Ref.get(fail))
									return yield* TransportError.make({
										cause: "The test SMTP server refused the message.",
									})
								yield* Ref.update(sent, Arr.append({ connection, message }))
							}),
					}),
				})
				const address = yield* host.address
				const account = Caller.withCookie({ address, publicOrigin })
				const keyed = Caller.withToken(address)
				const root = yield* host.login("root")
				const alice = yield* host.login("alice")
				const settings = yield* Caller.read(
					SettingsApi.PlatformSettings,
					account(root.session, "/v1/platform/settings"),
				)
				assert.strictEqual(settings.mail, null)
				assert.deepStrictEqual(
					yield* Caller.read(
						Mail.Delivery,
						account(root.session, "/v1/platform/mail/test", "POST", {
							to: "root@example.com",
						}),
					),
					{ status: "disabled" },
				)
				assert.strictEqual(
					(yield* account(alice.session, "/v1/platform/mail/test", "POST", {
						to: "alice@example.com",
					})).status,
					403,
				)
				assert.strictEqual(
					(yield* account(alice.session, "/v1/platform/settings", "PATCH", {
						expectedVersion: settings.version,
						mail: null,
					})).status,
					403,
				)
				const response = yield* account(
					root.session,
					"/v1/platform/settings",
					"PATCH",
					{
						expectedVersion: settings.version,
						mail: { ...fields, password: "long test password" },
					},
				)
				const configured = yield* Caller.json(
					SettingsApi.PlatformSettings,
					200,
				)(response)
				assert.deepStrictEqual(configured.mail?.password, {
					set: true,
					hint: null,
				})
				assert.strictEqual(
					Str.includes("long test password")(yield* response.text),
					false,
				)
				assert.deepStrictEqual(
					yield* Caller.read(
						Mail.Delivery,
						account(root.session, "/v1/platform/mail/test", "POST", {
							to: "root@example.com",
						}),
					),
					{ status: "sent" },
				)
				const first = (yield* Ref.get(sent))[0]
				assert.ok(first !== undefined && first.connection.password !== null)
				assert.strictEqual(
					Redacted.value(first.connection.password),
					"long test password",
				)
				assert.strictEqual(first.message.to, "root@example.com")
				assert.deepStrictEqual(first.message.from, {
					address: fields.from,
					name: fields.fromName,
				})

				const readOnlyPolicy = yield* Policies.json(function* (_) {
					yield* _.allow("read", Authorization.Platform)
				})
				const writePolicy = yield* Policies.json(function* (_) {
					yield* _.allow("*", Authorization.Platform)
				})
				const readOnly = yield* Caller.read(
					UserTokensApi.CreatedToken,
					account(root.session, "/v1/user/tokens", "POST", {
						name: "Read mail settings",
						policy: readOnlyPolicy,
					}),
				)
				assert.strictEqual(
					(yield* keyed(readOnly.secret, "/v1/platform/mail/test", "POST", {
						to: "root@example.com",
					})).status,
					403,
				)
				const writer = yield* Caller.read(
					UserTokensApi.CreatedToken,
					account(root.session, "/v1/user/tokens", "POST", {
						name: "Write mail settings",
						policy: writePolicy,
					}),
				)
				const changed = yield* Caller.read(
					SettingsApi.PlatformSettings,
					keyed(writer.secret, "/v1/platform/settings", "PATCH", {
						expectedVersion: configured.version,
						mail: { ...fields, fromName: "OpenBot Team" },
					}),
				)
				assert.strictEqual(changed.mail?.password.set, true)
				assert.deepStrictEqual(
					yield* Caller.read(
						Mail.Delivery,
						keyed(writer.secret, "/v1/platform/mail/test", "POST", {
							to: "root@example.com",
						}),
					),
					{ status: "sent" },
				)
				assert.strictEqual(
					(yield* Ref.get(sent))[1]?.message.from.name,
					"OpenBot Team",
				)
				const nonAdmin = yield* Caller.read(
					UserTokensApi.CreatedToken,
					account(alice.session, "/v1/user/tokens", "POST", {
						name: "Not a platform admin",
						policy: writePolicy,
					}),
				)
				assert.strictEqual(
					(yield* keyed(nonAdmin.secret, "/v1/platform/mail/test", "POST", {
						to: "alice@example.com",
					})).status,
					403,
				)
				assert.strictEqual(
					(yield* account(root.session, "/v1/platform/mail/test", "POST", {
						to: "invalid",
					})).status,
					400,
				)
				yield* Ref.set(fail, true)
				assert.deepStrictEqual(
					yield* Caller.read(
						Mail.Delivery,
						keyed(writer.secret, "/v1/platform/mail/test", "POST", {
							to: "root@example.com",
						}),
					),
					{ status: "failed" },
				)
				const cleared = yield* Caller.read(
					SettingsApi.PlatformSettings,
					keyed(writer.secret, "/v1/platform/settings", "PATCH", {
						expectedVersion: changed.version,
						mail: null,
					}),
				)
				assert.strictEqual(cleared.mail, null)
				assert.deepStrictEqual(
					yield* Caller.read(
						Mail.Delivery,
						keyed(writer.secret, "/v1/platform/mail/test", "POST", {
							to: "root@example.com",
						}),
					),
					{ status: "disabled" },
				)
				assert.strictEqual((yield* Ref.get(sent)).length, 2)
			}),
		{ timeout: 60000 },
	)
})
