import { assert, it } from "@effect/vitest"
import { BotMemory, BotsApi, RequestsApi } from "@openbot-build/api"
import { Schema } from "effect"
import * as BrowserHost from "./BrowserHost.ts"
import { withCookie, withToken } from "./Caller.ts"
import { message, settled, talk } from "./Messages.ts"

const publicOrigin = "https://sharing.example.com"

it(
	"a person joins a shared Bot by invitation and uses it in their own organization",
	{ timeout: 180000 },
	async () => {
		// Each person gets their own organization.
		const host = await BrowserHost.start({ publicOrigin, sharedDomain: false })
		try {
			const send = withCookie({ address: host.address, publicOrigin })
			const json = async <A, I>(
				schema: Schema.Codec<A, I>,
				response: Promise<Response>,
				status = 200,
			): Promise<A> => {
				const value = await response
				const body = await value.text()
				assert.strictEqual(value.status, status, body)
				return Schema.decodeUnknownSync(schema)(JSON.parse(body))
			}
			const until = async <A>(
				label: string,
				check: () => Promise<A | undefined>,
			): Promise<A> => {
				for (let tries = 0; tries < 400; tries++) {
					const value = await check()
					if (value !== undefined) return value
					await new Promise((resolve) => setTimeout(resolve, 25))
				}
				throw new Error("Timed out: " + label)
			}
			const alice = await host.login("sharing-alice")
			const carol = await host.login("sharing-carol")
			const dave = await host.login("sharing-dave")
			assert.notStrictEqual(
				alice.identity.organizationId,
				carol.identity.organizationId,
			)

			const guide = await json(
				BotsApi.Bot,
				send(alice.session, "/v1/bots", "POST", {
					name: "Guide",
					role: "Answers questions",
					instructions: "Answer short.",
				}),
				201,
			)
			// Only a top Bot can be shared. A Bot that a Bot owns cannot.
			const child = await json(
				BotsApi.Bot,
				send(alice.session, "/v1/bots", "POST", {
					name: "Child",
					role: "Helps",
					instructions: "Help.",
					bot: guide.id,
				}),
				201,
			)
			assert.strictEqual(
				(
					await send(
						alice.session,
						`/v1/bots/${child.id}/invitations`,
						"POST",
						{},
					)
				).status,
				400,
			)

			// An invitation link, ready for a QR code.
			const link = await json(
				BotsApi.BotInvitationSecret,
				send(alice.session, `/v1/bots/${guide.id}/invitations`, "POST", {
					path: "/join",
				}),
				201,
			)
			assert.ok(link.secret?.startsWith(BotsApi.InvitationSecretPrefix))
			assert.strictEqual(link.url, publicOrigin + "/join#" + link.secret)
			assert.strictEqual(link.invitation.email, null)
			assert.strictEqual(link.invitation.expiresAt, null)
			const again = await json(
				BotsApi.BotInvitationSecret,
				send(
					alice.session,
					`/v1/bots/${guide.id}/invitations/${link.invitation.id}/secret`,
				),
			)
			assert.strictEqual(again.secret, link.secret)
			// People of other organizations cannot manage the invitations.
			assert.strictEqual(
				(await send(carol.session, `/v1/bots/${guide.id}/invitations`)).status,
				404,
			)

			// Carol accepts the link in her own organization.
			const accept = (
				session: typeof carol.session,
				payload: Record<string, unknown>,
				status = 200,
			) =>
				json(
					BotsApi.Bot,
					send(session, "/v1/bot-invitations/accept", "POST", payload),
					status,
				)
			const linked = await accept(carol.session, { secret: link.secret })
			assert.notStrictEqual(linked.id, guide.id)
			assert.strictEqual(linked.name, "Guide")
			assert.deepStrictEqual(linked.owner, {
				_tag: "Member",
				userId: carol.identity.userId,
			})
			assert.deepStrictEqual(linked.source, {
				organizationId: alice.identity.organizationId,
				bot: guide.id,
			})
			assert.strictEqual(
				(await accept(carol.session, { secret: link.secret })).id,
				linked.id,
			)
			const listed = await json(
				Schema.Array(BotsApi.Bot),
				send(carol.session, "/v1/bots"),
			)
			assert.ok(listed.some((bot) => bot.id === linked.id))
			assert.deepStrictEqual(
				(
					await json(
						Schema.Array(BotsApi.BotMember),
						send(alice.session, `/v1/bots/${guide.id}/members`),
					)
				).map((member) => [member.userId, member.organizationId]),
				[[carol.identity.userId, carol.identity.organizationId]],
			)

			// Only the people of the shared Bot change what it is.
			assert.strictEqual(
				(
					await send(carol.session, `/v1/bots/${linked.id}`, "PATCH", {
						expected: linked.revision,
						instructions: "Something else.",
					})
				).status,
				400,
			)
			await json(
				BotsApi.Bot,
				send(alice.session, `/v1/bots/${guide.id}`, "PATCH", {
					expected: guide.revision,
					name: "Guide Two",
				}),
			)
			assert.strictEqual(
				(await json(BotsApi.Bot, send(carol.session, `/v1/bots/${linked.id}`)))
					.name,
				"Guide Two",
			)

			// Carol talks to it in her own Chat, and decides its requests herself.
			const asCarol = (
				path: string,
				method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
				payload?: unknown,
			) => send(carol.session, path, method, payload)
			const hello = await talk(asCarol, linked.id, "Hello")
			assert.strictEqual(hello.view.chat.bot, linked.id)
			assert.strictEqual(hello.view.chat.kind, "direct")
			assert.strictEqual(hello.view.status, "Completed")
			// The Chat is in the organization of Carol. The people of the shared Bot do not see it.
			assert.strictEqual(
				(await send(alice.session, "/v1/chats/" + hello.receipt.chat)).status,
				404,
			)
			const asked = await message(asCarol, linked.id, "This needs approval")
			assert.strictEqual(asked.chat, hello.receipt.chat)
			const pending = await until("a pending request", async () => {
				const list = await json(
					Schema.Array(RequestsApi.CapabilityRequest),
					send(carol.session, "/v1/requests?status=pending"),
				)
				return list[0]
			})
			assert.strictEqual(pending.bot, linked.id)
			assert.strictEqual(host.toolCalls(), 0)
			await json(
				RequestsApi.CapabilityRequest,
				send(carol.session, "/v1/requests/" + pending.id, "POST", {
					expected: pending.revision,
					decision: "allow",
					scope: "lifetime",
				}),
			)
			// The allowed call runs later, in the same Chat.
			await until("the allowed call runs", async () =>
				host.toolCalls() === 1 ? true : undefined,
			)
			await settled(asCarol, asked.chat)
			// Her decision is a Grant of her own linked Bot. The shared Bot does not get it.
			assert.strictEqual(
				(
					await json(
						Schema.Array(BotsApi.Grant),
						send(carol.session, `/v1/bots/${linked.id}/grants`),
					)
				).length,
				1,
			)
			assert.deepStrictEqual(
				await json(
					Schema.Array(BotsApi.Grant),
					send(alice.session, `/v1/bots/${guide.id}/grants`),
				),
				[],
			)

			// The pool lives with the shared Bot, but only Carol sees what is for her,
			// and only in her own organization. The people of the Bot cannot read it.
			const remembered = await json(
				BotMemory.View,
				send(carol.session, `/v1/bots/${linked.id}/memory`, "POST", {
					command: { _tag: "Remember", content: "Carol likes tea." },
				}),
			)
			assert.deepStrictEqual(
				remembered.entries.map((entry) => entry.content),
				["Carol likes tea."],
			)
			const asOwner = await json(
				BotMemory.View,
				send(alice.session, `/v1/bots/${guide.id}/memory`),
			)
			assert.deepStrictEqual(asOwner.entries, [])
			// The owner can remove what Carol left without reading it.
			const purged = await json(
				BotMemory.PurgeResult,
				send(alice.session, `/v1/bots/${guide.id}/memory/purge`, "POST", {
					tag: "from:" + carol.identity.userId,
				}),
			)
			assert.strictEqual(purged.removed, 1)
			assert.deepStrictEqual(
				(
					await json(
						BotMemory.View,
						send(carol.session, `/v1/bots/${linked.id}/memory`),
					)
				).entries,
				[],
			)
			// Members do not manage the memory Bot of a shared Bot.
			assert.strictEqual(
				(await send(carol.session, `/v1/bots/${linked.id}/memory/bot`)).status,
				400,
			)

			// An email invitation shows in the list of the person, and needs the Bot route.
			const emailed = await json(
				BotsApi.BotInvitationSecret,
				send(alice.session, `/v1/bots/${guide.id}/invitations`, "POST", {
					email: "sharing-dave@example.com",
				}),
				201,
			)
			assert.strictEqual(emailed.secret, null)
			const mine = (await (
				await send(dave.session, "/v1/invitations")
			).json()) as {
				readonly items: ReadonlyArray<{
					readonly id: string
					readonly bot?: { readonly id: string }
				}>
			}
			assert.deepStrictEqual(
				mine.items.map((item) => [item.id, item.bot?.id]),
				[[emailed.invitation.id, guide.id]],
			)
			assert.strictEqual(
				(
					await send(
						dave.session,
						`/v1/invitations/${emailed.invitation.id}/accept`,
						"POST",
					)
				).status,
				400,
			)
			assert.strictEqual(
				(
					await send(carol.session, "/v1/bot-invitations/accept", "POST", {
						invitation: emailed.invitation.id,
					})
				).status,
				404,
			)
			const daveLinked = await accept(dave.session, {
				invitation: emailed.invitation.id,
			})
			assert.strictEqual(
				(
					await send(dave.session, "/v1/bot-invitations/accept", "POST", {
						invitation: emailed.invitation.id,
					})
				).status,
				400,
			)

			// Leaving: archiving a linked Bot ends the membership.
			await json(
				BotsApi.Bot,
				send(dave.session, `/v1/bots/${daveLinked.id}`, "PATCH", {
					expected: daveLinked.revision,
					archived: true,
				}),
			)
			assert.deepStrictEqual(
				(
					await json(
						Schema.Array(BotsApi.BotMember),
						send(alice.session, `/v1/bots/${guide.id}/members`),
					)
				).map((member) => member.userId),
				[carol.identity.userId],
			)

			// A user token works like the session cookie.
			const erin = await host.login("sharing-erin")
			const token = (await (
				await send(erin.session, "/v1/user/tokens", "POST", { name: "join" })
			).json()) as { readonly secret: string }
			const joined = await withToken(host.address)(
				token.secret,
				"/v1/bot-invitations/accept",
				"POST",
				{ secret: link.secret },
			)
			assert.strictEqual(joined.status, 200, await joined.clone().text())

			// A revoked link opens no more. The people who joined stay.
			assert.strictEqual(
				(
					await send(
						alice.session,
						`/v1/bots/${guide.id}/invitations/${link.invitation.id}`,
						"DELETE",
					)
				).status,
				204,
			)
			const frank = await host.login("sharing-frank")
			assert.strictEqual(
				(
					await send(frank.session, "/v1/bot-invitations/accept", "POST", {
						secret: link.secret,
					})
				).status,
				400,
			)
			assert.strictEqual(
				(await send(carol.session, `/v1/bots/${linked.id}`)).status,
				200,
			)

			// When the people of the shared Bot take Carol off, her linked Bot stops.
			assert.strictEqual(
				(
					await send(
						alice.session,
						`/v1/bots/${guide.id}/members/${carol.identity.userId}`,
						"DELETE",
					)
				).status,
				204,
			)
			assert.strictEqual(
				(await send(carol.session, `/v1/bots/${linked.id}`)).status,
				404,
			)
		} finally {
			await host.close()
		}
	},
)
