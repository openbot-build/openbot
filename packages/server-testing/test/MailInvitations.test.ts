import { FetchHttpClient } from "effect/http"
import { NodeServices, NodeCrypto } from "@effect/platform-node"
import { PlatformSettings } from "@openbot-build/domain/Settings"
import {
	CreateInvitationResponse,
	Invitation,
} from "@openbot-build/domain/Organizations"
import { Mail } from "@openbot-build/domain"
import { CreatedToken } from "@openbot-build/domain/Tokens"
import { Bot } from "@openbot-build/domain/Bots"
import {
	BotInvitationSecret,
	BotInvitation,
} from "@openbot-build/domain/BotSharing"
import { assert, layer } from "@effect/vitest"
import { Array as Arr, Effect, Layer, Ref, Schema } from "effect"
import {
	Transport,
	TransportError,
	type Message,
} from "@openbot-build/identity-contract/mail/Transport"
import * as BrowserHost from "../src/BrowserHost.ts"
import * as Caller from "../src/Caller.ts"

const publicOrigin = "https://mail.example.com"

layer(
	Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer),
	{
		excludeTestServices: true,
	},
)((it) => {
	it.effect(
		"an invitation stays saved after a mail failure and can be sent again",
		() =>
			Effect.gen(function* () {
				const attempts = yield* Ref.make<ReadonlyArray<Message>>([])
				const fail = yield* Ref.make(true)
				const host = yield* BrowserHost.start({
					publicOrigin,
					sharedDomain: false,
					platformAdmins: ["mail-admin@example.com"],
					mailTransport: Layer.succeed(Transport, {
						send: (_, message) =>
							Effect.gen(function* () {
								yield* Ref.update(attempts, Arr.append(message))
								if (yield* Ref.get(fail))
									return yield* TransportError.make({
										cause: "The test mail server refused the message.",
									})
							}),
					}),
				})
				const address = yield* host.address
				const send = Caller.withCookie({ address, publicOrigin })
				const admin = yield* host.login("mail-admin")
				const settings = yield* Caller.read(
					PlatformSettings,
					send(admin.session, "/v1/platform/settings"),
				)
				yield* Caller.read(
					PlatformSettings,
					send(admin.session, "/v1/platform/settings", "PATCH", {
						expectedVersion: settings.version,
						mail: {
							host: "smtp.example.com",
							port: 587,
							security: "starttls",
							from: "openbot@example.com",
							fromName: "OpenBot",
							username: null,
							password: null,
							invitationUrl: "https://mail.example.com/",
						},
					}),
				)
				const invite = (email: string) =>
					send(admin.session, "/v1/organization/invitations", "POST", { email })
				const invitation = yield* Caller.read(
					CreateInvitationResponse,
					invite("Mail-Guest@example.com"),
					201,
				)
				assert.deepStrictEqual(invitation.delivery, { status: "failed" })
				assert.strictEqual(invitation.status, "pending")
				assert.strictEqual(invitation.email, "mail-guest@example.com")
				assert.strictEqual((yield* Ref.get(attempts)).length, 1)
				assert.strictEqual(
					(yield* invite("mail-guest@example.com")).status,
					400,
				)
				assert.strictEqual((yield* Ref.get(attempts)).length, 1)
				const list = () =>
					Caller.read(
						Schema.Struct({ items: Schema.Array(Invitation) }),
						send(admin.session, "/v1/organization/invitations"),
					)
				const saved = (yield* list()).items[0]
				assert.strictEqual(saved?.id, invitation.id)
				assert.strictEqual(saved?.expiresAt, invitation.expiresAt)
				yield* Ref.set(fail, false)
				assert.deepStrictEqual(
					yield* Caller.read(
						Mail.Delivery,
						send(
							admin.session,
							`/v1/organization/invitations/${invitation.id}/resend`,
							"POST",
						),
					),
					{ status: "sent" },
				)
				assert.deepStrictEqual((yield* list()).items[0], saved)
				assert.strictEqual((yield* Ref.get(attempts)).length, 2)
				const delivered = (yield* Ref.get(attempts))[1]
				assert.ok(delivered !== undefined)
				assert.strictEqual(delivered.to, invitation.email)
				assert.include(delivered.text, invitation.organizationName)
				assert.include(delivered.html, invitation.email)

				const token = yield* Caller.read(
					CreatedToken,
					send(admin.session, "/v1/user/tokens", "POST", {
						name: "Send Bot invitations",
					}),
					201,
				)
				const keyed = Caller.withToken(address)
				const bot = yield* Caller.read(
					Bot,
					keyed(token.secret, "/v1/bots", "POST", {
						name: "Guide",
						role: "Answers questions",
						instructions: "Give short answers.",
					}),
					201,
				)
				const path = `/v1/bots/${bot.id}/invitations`
				const first = yield* Caller.read(
					BotInvitationSecret,
					keyed(token.secret, path, "POST", { email: "bot-guest@example.com" }),
					201,
				)
				assert.deepStrictEqual(first.delivery, { status: "sent" })
				assert.strictEqual((yield* Ref.get(attempts)).length, 3)
				assert.strictEqual(
					(yield* Ref.get(attempts))[2]?.to,
					"bot-guest@example.com",
				)
				assert.include((yield* Ref.get(attempts))[2]!.text, "Guide")
				const link = yield* Caller.read(
					BotInvitationSecret,
					keyed(token.secret, path, "POST", { path: "/join" }),
					201,
				)
				assert.strictEqual(link.delivery, undefined)
				assert.strictEqual((yield* Ref.get(attempts)).length, 3)
				yield* Ref.set(fail, true)
				const failed = yield* Caller.read(
					BotInvitationSecret,
					keyed(token.secret, path, "POST", {
						email: "another-guest@example.com",
					}),
					201,
				)
				assert.deepStrictEqual(failed.delivery, { status: "failed" })
				assert.strictEqual((yield* Ref.get(attempts)).length, 4)
				yield* Ref.set(fail, false)
				assert.deepStrictEqual(
					yield* Caller.read(
						Mail.Delivery,
						keyed(
							token.secret,
							`${path}/${failed.invitation.id}/resend`,
							"POST",
						),
					),
					{ status: "sent" },
				)
				const listed = yield* Caller.read(
					Schema.Array(BotInvitation),
					keyed(token.secret, path),
				)
				assert.ok(
					Arr.some(
						listed,
						(item) =>
							item.id === failed.invitation.id &&
							item.status === "pending" &&
							item.expiresAt === failed.invitation.expiresAt,
					),
				)
				assert.strictEqual((yield* Ref.get(attempts)).length, 5)
				assert.strictEqual(
					(yield* Ref.get(attempts))[4]?.to,
					"another-guest@example.com",
				)
			}),
		{ timeout: 60000 },
	)
})
