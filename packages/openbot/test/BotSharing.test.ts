import { assert, layer } from "@effect/vitest"
import {
	BotMemory,
	BotsApi,
	OrganizationApi,
	RequestsApi,
	UserTokensApi,
} from "@openbot-build/api"
import {
	Array as Arr,
	Effect,
	Option,
	Schedule,
	Schema,
	String as Str,
} from "effect"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import { message, settled, talk, type Send } from "./Messages.ts"

const publicOrigin = "https://sharing.example.com"

/** A condition of the test did not come true in time. */
class TimedOut extends Schema.TaggedError<
	TimedOut,
	{ readonly brand: unique symbol }
>()("TimedOut", { label: Schema.String }) {
	override get message() {
		return "Timed out: " + this.label
	}
}

/**
 * Reads the JSON body of an answer with a schema, and checks its status. The
 * server writes the JSON form of each schema, where a missing optional value is null.
 */
const json = <S extends Schema.Constraint>(
	schema: S,
	call: Caller.Call,
	status = 200,
) => Effect.flatMap(call, Caller.json(Schema.toCodecJson(schema), status))

/** Runs a check again until it gives a value, at most 400 times. */
const until = <A, E, R>(
	label: string,
	check: Effect.Effect<Option.Option<A>, E, R>,
) =>
	check.pipe(
		Effect.repeat({
			until: Option.isSome,
			schedule: Schedule.spaced("25 millis"),
			times: 399,
		}),
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.fail(TimedOut.make({ label })),
				onSome: Effect.succeed,
			}),
		),
	)

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"a person joins a shared Bot by invitation and uses it in their own organization",
		() =>
			Effect.gen(function* () {
				// Each person gets their own organization.
				const host = yield* BrowserHost.start({
					publicOrigin,
					sharedDomain: false,
				})
				const address = yield* host.address
				const send = Caller.withCookie({ address, publicOrigin })
				const alice = yield* host.login("sharing-alice")
				const carol = yield* host.login("sharing-carol")
				const dave = yield* host.login("sharing-dave")
				assert.notStrictEqual(
					alice.identity.organizationId,
					carol.identity.organizationId,
				)

				const guide = yield* json(
					BotsApi.Bot,
					send(alice.session, "/v1/bots", "POST", {
						name: "Guide",
						role: "Answers questions",
						instructions: "Answer short.",
					}),
					201,
				)
				// Only a top Bot can be shared. A Bot that a Bot owns cannot.
				const child = yield* json(
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
					(yield* send(
						alice.session,
						`/v1/bots/${child.id}/invitations`,
						"POST",
						{},
					)).status,
					400,
				)

				// An invitation link, ready for a QR code.
				const link = yield* json(
					BotsApi.BotInvitationSecret,
					send(alice.session, `/v1/bots/${guide.id}/invitations`, "POST", {
						path: "/join",
					}),
					201,
				)
				assert.ok(
					link.secret !== null &&
						Str.startsWith(BotsApi.InvitationSecretPrefix)(link.secret),
				)
				assert.strictEqual(link.url, publicOrigin + "/join#" + link.secret)
				assert.strictEqual(link.invitation.email, null)
				assert.strictEqual(link.invitation.expiresAt, null)
				const again = yield* json(
					BotsApi.BotInvitationSecret,
					send(
						alice.session,
						`/v1/bots/${guide.id}/invitations/${link.invitation.id}/secret`,
					),
				)
				assert.strictEqual(again.secret, link.secret)
				// People of other organizations cannot manage the invitations.
				assert.strictEqual(
					(yield* send(carol.session, `/v1/bots/${guide.id}/invitations`))
						.status,
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
				const linked = yield* accept(carol.session, { secret: link.secret })
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
					(yield* accept(carol.session, { secret: link.secret })).id,
					linked.id,
				)
				const listed = yield* json(
					Schema.Array(BotsApi.Bot),
					send(carol.session, "/v1/bots"),
				)
				assert.ok(Arr.some(listed, (bot) => bot.id === linked.id))
				assert.deepStrictEqual(
					Arr.map(
						yield* json(
							Schema.Array(BotsApi.BotMember),
							send(alice.session, `/v1/bots/${guide.id}/members`),
						),
						(member) => [member.userId, member.organizationId],
					),
					[[carol.identity.userId, carol.identity.organizationId]],
				)

				// Only the people of the shared Bot change what it is.
				assert.strictEqual(
					(yield* send(carol.session, `/v1/bots/${linked.id}`, "PATCH", {
						expected: linked.revision,
						instructions: "Something else.",
					})).status,
					400,
				)
				yield* json(
					BotsApi.Bot,
					send(alice.session, `/v1/bots/${guide.id}`, "PATCH", {
						expected: guide.revision,
						name: "Guide Two",
					}),
				)
				assert.strictEqual(
					(yield* json(
						BotsApi.Bot,
						send(carol.session, `/v1/bots/${linked.id}`),
					)).name,
					"Guide Two",
				)

				// Carol talks to it in her own Chat, and decides its requests herself.
				const asCarol: Send = (path, method, payload) =>
					send(carol.session, path, method, payload)
				const hello = yield* talk(asCarol, linked.id, "Hello")
				assert.strictEqual(hello.view.chat.bot, linked.id)
				assert.strictEqual(hello.view.chat.kind, "direct")
				assert.strictEqual(hello.view.status, "Completed")
				// The Chat is in the organization of Carol. The people of the shared Bot do not see it.
				assert.strictEqual(
					(yield* send(alice.session, "/v1/chats/" + hello.receipt.chat))
						.status,
					404,
				)
				const asked = yield* message(asCarol, linked.id, "This needs approval")
				assert.strictEqual(asked.chat, hello.receipt.chat)
				const pending = yield* until(
					"a pending request",
					Effect.map(
						json(
							Schema.Array(RequestsApi.CapabilityRequest),
							send(carol.session, "/v1/requests?status=pending"),
						),
						Arr.head,
					),
				)
				assert.strictEqual(pending.bot, linked.id)
				assert.strictEqual(yield* host.toolCalls, 0)
				yield* json(
					RequestsApi.CapabilityRequest,
					send(carol.session, "/v1/requests/" + pending.id, "POST", {
						expected: pending.revision,
						decision: "allow",
						scope: "lifetime",
					}),
				)
				// The allowed call runs later, in the same Chat.
				yield* until(
					"the allowed call runs",
					Effect.map(
						host.toolCalls,
						Option.liftPredicate((count) => count === 1),
					),
				)
				yield* settled(asCarol, asked.chat)
				// Her decision is a Grant of her own linked Bot. The shared Bot does not get it.
				assert.strictEqual(
					(yield* json(
						Schema.Array(BotsApi.Grant),
						send(carol.session, `/v1/bots/${linked.id}/grants`),
					)).length,
					1,
				)
				assert.deepStrictEqual(
					yield* json(
						Schema.Array(BotsApi.Grant),
						send(alice.session, `/v1/bots/${guide.id}/grants`),
					),
					[],
				)

				// The pool lives with the shared Bot, but only Carol sees what is for her,
				// and only in her own organization. The people of the Bot cannot read it.
				const remembered = yield* json(
					BotMemory.View,
					send(carol.session, `/v1/bots/${linked.id}/memory`, "POST", {
						command: { _tag: "Remember", content: "Carol likes tea." },
					}),
				)
				assert.deepStrictEqual(
					Arr.map(remembered.entries, (entry) => entry.content),
					["Carol likes tea."],
				)
				const asOwner = yield* json(
					BotMemory.View,
					send(alice.session, `/v1/bots/${guide.id}/memory`),
				)
				assert.deepStrictEqual(asOwner.entries, [])
				// The owner can remove what Carol left without reading it.
				const purged = yield* json(
					BotMemory.PurgeResult,
					send(alice.session, `/v1/bots/${guide.id}/memory/purge`, "POST", {
						tag: "from:" + carol.identity.userId,
					}),
				)
				assert.strictEqual(purged.removed, 1)
				assert.deepStrictEqual(
					(yield* json(
						BotMemory.View,
						send(carol.session, `/v1/bots/${linked.id}/memory`),
					)).entries,
					[],
				)
				// Members do not manage the memory Bot of a shared Bot.
				assert.strictEqual(
					(yield* send(carol.session, `/v1/bots/${linked.id}/memory/bot`))
						.status,
					400,
				)

				// An email invitation shows in the list of the person, and needs the Bot route.
				const emailed = yield* json(
					BotsApi.BotInvitationSecret,
					send(alice.session, `/v1/bots/${guide.id}/invitations`, "POST", {
						email: "sharing-dave@example.com",
					}),
					201,
				)
				assert.strictEqual(emailed.secret, null)
				const mine = yield* json(
					Schema.Struct({ items: Schema.Array(OrganizationApi.Invitation) }),
					send(dave.session, "/v1/invitations"),
				)
				assert.deepStrictEqual(
					Arr.map(mine.items, (item) => [item.id, item.bot?.id]),
					[[emailed.invitation.id, guide.id]],
				)
				assert.strictEqual(
					(yield* send(
						dave.session,
						`/v1/invitations/${emailed.invitation.id}/accept`,
						"POST",
					)).status,
					400,
				)
				assert.strictEqual(
					(yield* send(carol.session, "/v1/bot-invitations/accept", "POST", {
						invitation: emailed.invitation.id,
					})).status,
					404,
				)
				const daveLinked = yield* accept(dave.session, {
					invitation: emailed.invitation.id,
				})
				assert.strictEqual(
					(yield* send(dave.session, "/v1/bot-invitations/accept", "POST", {
						invitation: emailed.invitation.id,
					})).status,
					400,
				)

				// Leaving: archiving a linked Bot ends the membership.
				yield* json(
					BotsApi.Bot,
					send(dave.session, `/v1/bots/${daveLinked.id}`, "PATCH", {
						expected: daveLinked.revision,
						archived: true,
					}),
				)
				assert.deepStrictEqual(
					Arr.map(
						yield* json(
							Schema.Array(BotsApi.BotMember),
							send(alice.session, `/v1/bots/${guide.id}/members`),
						),
						(member) => member.userId,
					),
					[carol.identity.userId],
				)

				// A user token works like the session cookie.
				const erin = yield* host.login("sharing-erin")
				const token = yield* json(
					UserTokensApi.CreatedToken,
					send(erin.session, "/v1/user/tokens", "POST", { name: "join" }),
					201,
				)
				const joined = yield* Caller.withToken(address)(
					token.secret,
					"/v1/bot-invitations/accept",
					"POST",
					{ secret: link.secret },
				)
				assert.strictEqual(joined.status, 200, yield* joined.text)

				// A revoked link opens no more. The people who joined stay.
				assert.strictEqual(
					(yield* send(
						alice.session,
						`/v1/bots/${guide.id}/invitations/${link.invitation.id}`,
						"DELETE",
					)).status,
					204,
				)
				const frank = yield* host.login("sharing-frank")
				assert.strictEqual(
					(yield* send(frank.session, "/v1/bot-invitations/accept", "POST", {
						secret: link.secret,
					})).status,
					400,
				)
				assert.strictEqual(
					(yield* send(carol.session, `/v1/bots/${linked.id}`)).status,
					200,
				)

				// When the people of the shared Bot take Carol off, her linked Bot stops.
				assert.strictEqual(
					(yield* send(
						alice.session,
						`/v1/bots/${guide.id}/members/${carol.identity.userId}`,
						"DELETE",
					)).status,
					204,
				)
				assert.strictEqual(
					(yield* send(carol.session, `/v1/bots/${linked.id}`)).status,
					404,
				)
			}),
		{ timeout: 180000 },
	)
})
