import { Execution } from "@openbot-build/domain"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no API for HMAC signatures or AES ciphers.
import { createCipheriv, createHmac } from "node:crypto"
import { assert, layer } from "@effect/vitest"
import {
	BotsApi,
	ChannelsApi,
	ChatSummary,
	RequestsApi,
	UserTokensApi,
} from "@openbot-build/api"
import { Item, Turn } from "@openbot-build/core"
import { Network } from "@openbot-build/protocol/Network"
import {
	Array as Arr,
	Clock,
	Crypto,
	Effect,
	Layer,
	Option,
	pipe,
	Random,
	Redacted,
	Ref,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { AppHost } from "@openbot-build/openbot"
import {
	BrowserHost,
	Caller,
	ChannelPlatformScenarios,
	Wait,
} from "@openbot-build/openbot/testing"

const { until } = Wait

const publicOrigin = "https://channels.example.com"

type Send = ReturnType<typeof Caller.withCookie>

/** The JSON body of a call to a platform that the test plays. */
const Body = Schema.Record(Schema.String, Schema.Unknown)
type Body = typeof Body.Type

const decodeBody = Schema.decodeEffect(Schema.fromJsonString(Body))
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const TurnPage = Schema.Struct({ items: Schema.Array(Turn.Record) })
const ItemPage = Schema.Struct({ items: Schema.Array(Item.Record) })

/** One call of OpenBot to a platform that the test plays. */
interface PlatformCall {
	readonly method: string
	readonly body: Body
}

/** Posts a body to a webhook, as a platform does. */
const post = (
	url: string,
	body: string,
	contentType: string,
	headers: Record<string, string>,
) =>
	HttpClientRequest.post(url, { headers }).pipe(
		HttpClientRequest.bodyText(body, contentType),
		HttpClient.execute,
	)

/** Makes a shared Bot in the organization of the owner, and gives its id. */
const sharedBot = (send: Send, owner: Redacted.Redacted<string>) =>
	Effect.map(
		Caller.read(
			BotsApi.Bot,
			send(owner, "/v1/bots", "POST", {
				name: "Team Bot",
				role: "Helps the team in chat",
				instructions: "Answer short.",
				shared: true,
			}),
			201,
		),
		(bot) => bot.id,
	)

// The hosts use real servers, so these tests run on the real clock.
layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"a Slack Channel links people, keeps one Chat for each chat, works for the speaker, and decides requests with buttons",
		() =>
			Effect.gen(function* () {
				const signingSecret = "slack-signing-secret-for-tests"
				/** A Slack call, with its blocks as JSON text when it has blocks. */
				interface SlackCall extends PlatformCall {
					readonly blocks: Option.Option<string>
				}
				const slack = yield* Ref.make<ReadonlyArray<SlackCall>>([])
				const findCall = (predicate: (call: SlackCall) => boolean) =>
					Effect.map(Ref.get(slack), Arr.findFirst(predicate))
				// The test plays Slack.
				const platformFetch = (request: Request) =>
					Effect.gen(function* () {
						const url = new URL(request.url)
						assert.strictEqual(url.origin, "https://slack.com")
						assert.strictEqual(
							request.headers.get("authorization"),
							"Bearer xoxb-test-token-123456",
						)
						const body = yield* decodeBody(
							yield* Effect.promise(() => request.text()),
						)
						const blocks = Arr.isArray(body["blocks"])
							? Option.some(yield* encodeJson(body["blocks"]))
							: Option.none<string>()
						const calls = yield* Ref.updateAndGet(
							slack,
							Arr.append({
								method: Str.replace("/api/", "")(url.pathname),
								body,
								blocks,
							}),
						)
						const ts = String(calls.length)
						const channel = String(body["channel"])
						return Response.json({
							ok: true,
							channel: Str.startsWith("U")(channel) ? "D" + channel : channel,
							ts,
							message_ts: ts,
						})
					}).pipe(Effect.orDie)
				const host = yield* BrowserHost.start({
					publicOrigin,
					platformFetch,
				})
				const address = yield* host.address
				const send = Caller.withCookie({ address, publicOrigin })
				const alice = yield* host.login("channels-alice")
				const bob = yield* host.login("channels-bob")
				const bot = yield* sharedBot(send, alice.session)

				// Only administrators manage Channels. Secrets never come back.
				const payload = {
					commandKey: "channel-slack",
					name: "Team Slack",
					bot,
					linkPath: "/link",
					credentials: {
						kind: "slack",
						botToken: "xoxb-test-token-123456",
						signingSecret,
					},
				}
				const refused = yield* send(
					bob.session,
					"/v1/organization/channels",
					"POST",
					payload,
				)
				assert.strictEqual(refused.status, 403)
				const created = yield* send(
					alice.session,
					"/v1/organization/channels",
					"POST",
					payload,
				)
				const channel = yield* Caller.json(ChannelsApi.Channel, 201)(created)
				assert.strictEqual(channel.actor, alice.identity.userId)
				assert.strictEqual(
					channel.webhookUrl,
					`${publicOrigin}/v1/hooks/channels/${channel.id}`,
				)
				assert.deepStrictEqual(channel.credentials, {
					kind: "slack",
					botToken: { set: true, hint: "…3456" },
					signingSecret: { set: true, hint: "…ests" },
				})
				assert.notMatch(yield* created.text, /xoxb-test-token|signing-secret/)
				const mine = yield* Caller.read(
					BotsApi.Bot,
					send(alice.session, "/v1/bots", "POST", {
						name: "Private Bot",
						role: "Mine",
						instructions: "Help me.",
					}),
					201,
				)
				const wrongBot = yield* send(
					alice.session,
					"/v1/organization/channels",
					"POST",
					{
						...payload,
						commandKey: "channel-private-bot",
						bot: mine.id,
					},
				)
				assert.strictEqual(wrongBot.status, 400)

				const hook = (
					body: string,
					options: {
						readonly secret?: string
						readonly age?: number
						readonly form?: boolean
					} = {},
				) =>
					Effect.gen(function* () {
						const now = yield* Clock.currentTimeMillis
						const timestamp = String(
							Math.floor(now / 1000) - (options.age ?? 0),
						)
						const signature =
							"v0=" +
							createHmac("sha256", options.secret ?? signingSecret)
								.update(`v0:${timestamp}:${body}`)
								.digest("hex")
						return yield* post(
							address + "/v1/hooks/channels/" + channel.id,
							body,
							options.form === true
								? "application/x-www-form-urlencoded"
								: "application/json",
							{
								"x-slack-request-timestamp": timestamp,
								"x-slack-signature": signature,
							},
						)
					})
				const verification = yield* encodeJson({
					type: "url_verification",
					challenge: "c-123",
				})
				assert.deepStrictEqual(
					yield* Caller.read(Schema.Json, hook(verification), 200),
					{
						challenge: "c-123",
					},
				)
				assert.strictEqual(
					(yield* hook(verification, { secret: "wrong" })).status,
					401,
				)
				assert.strictEqual(
					(yield* hook(verification, { age: 600 })).status,
					401,
				)

				const events = yield* Ref.make(0)
				const message = (input: {
					readonly user: string
					readonly text: string
					readonly channel: string
					readonly direct: boolean
					readonly id?: string
				}) =>
					Effect.gen(function* () {
						const event = yield* Ref.updateAndGet(events, (count) => count + 1)
						return yield* hook(
							yield* encodeJson({
								type: "event_callback",
								event_id: input.id ?? "Ev" + event,
								event: {
									type: input.direct ? "message" : "app_mention",
									channel_type: input.direct ? "im" : "channel",
									channel: input.channel,
									user: input.user,
									text: input.text,
									ts: String(event),
								},
							}),
						)
					})
				const action = (user: string, value: string) =>
					Effect.gen(function* () {
						const trigger = yield* Random.next
						const now = yield* Clock.currentTimeMillis
						const actionPayload = yield* encodeJson({
							type: "block_actions",
							trigger_id: "trigger-" + trigger,
							user: { id: user, name: user },
							channel: { id: "D" + user },
							actions: [{ action_ts: String(now), value }],
						})
						return yield* hook("payload=" + encodeURIComponent(actionPayload), {
							form: true,
						})
					})
				const channelChats = Caller.read(
					Schema.Array(ChatSummary),
					send(alice.session, "/v1/chats?kind=channel"),
					200,
				)
				const turnsOf = (chat: string) =>
					Effect.map(
						Caller.read(
							TurnPage,
							send(alice.session, "/v1/chats/" + chat + "/turns"),
							200,
						),
						(page) => page.items,
					)

				// A person who is not linked gets a link in the direct chat, and nothing runs.
				assert.strictEqual(
					(yield* message({
						user: "UBOB",
						text: "hello",
						channel: "DUBOB",
						direct: true,
					})).status,
					200,
				)
				const prompt = yield* until(
					"the link prompt",
					findCall(
						(call) =>
							call.method === "chat.postMessage" &&
							Str.includes("/link?code=")(String(call.body["text"])),
					),
				)
				assert.strictEqual(prompt.body["channel"], "DUBOB")
				const code = pipe(
					String(prompt.body["text"]),
					Str.match(/code=([^\s)]+)/),
					Option.flatMap(Arr.get(1)),
					Option.map(decodeURIComponent),
				)
				assert.ok(Option.isSome(code))
				assert.strictEqual((yield* channelChats).length, 0)

				// The person opens the link in OpenBot and accepts it. A code works once.
				const linkPath = "/v1/channel-links/" + encodeURIComponent(code.value)
				const link = yield* Caller.read(
					ChannelsApi.ChannelLink,
					send(bob.session, linkPath),
					200,
				)
				assert.strictEqual(link.externalUserId, "UBOB")
				assert.strictEqual(link.channelName, "Team Slack")
				const linked = yield* Caller.read(
					ChannelsApi.ChannelIdentity,
					send(bob.session, linkPath + "/accept", "POST"),
					200,
				)
				assert.strictEqual(linked.userId, bob.identity.userId)
				assert.strictEqual(
					(yield* send(bob.session, linkPath + "/accept", "POST")).status,
					404,
				)
				assert.strictEqual(
					(yield* Caller.read(
						Schema.Array(ChannelsApi.ChannelIdentity),
						send(bob.session, "/v1/user/channel-identities"),
						200,
					)).length,
					1,
				)

				const checkSpeaker = (turn: Turn.Record) =>
					Effect.gen(function* () {
						const identities = yield* host.run(
							ChannelPlatformScenarios.turnAuthority(turn.id),
						)
						assert.strictEqual(identities.length, 1)
						const saved = identities[0]!
						assert.strictEqual(saved.actor.userId, bob.identity.userId)
						assert.strictEqual(saved.owner.userId, alice.identity.userId)
						assert.deepStrictEqual(saved.channel, {
							id: channel.id,
							externalUserId: "UBOB",
						})
					})

				// Now the Bot answers. The Chat belongs to the actor, and the Turn works for Bob.
				yield* message({
					user: "UBOB",
					text: "hello again",
					channel: "DUBOB",
					direct: true,
					id: "EvSame",
				})
				const answer = yield* until(
					"the answer in Slack",
					findCall(
						(call) =>
							call.method === "chat.update" &&
							Str.includes("A useful result")(String(call.body["text"])),
					),
				)
				assert.strictEqual(answer.body["channel"], "DUBOB")
				assert.ok(
					Arr.some(
						yield* Ref.get(slack),
						(call) =>
							call.method === "chat.postMessage" &&
							call.body["text"] === "Working…",
					),
				)
				const first = Arr.head(yield* channelChats)
				assert.ok(Option.isSome(first))
				const firstChat = first.value.chat.id
				// Channel use does not give the speaker access to the owner's stored Chat.
				assert.strictEqual(
					(yield* send(bob.session, "/v1/chats/" + firstChat)).status,
					404,
				)
				const lastTurn = Arr.last(yield* turnsOf(firstChat))
				assert.ok(Option.isSome(lastTurn))
				yield* checkSpeaker(lastTurn.value)
				// Slack sends an event again when it is not sure. It runs only once.
				yield* message({
					user: "UBOB",
					text: "hello again",
					channel: "DUBOB",
					direct: true,
					id: "EvSame",
				})
				// The worker takes the events of one chat in order. So when the next message
				// is in the Chat, a copy that got in is there too, in a Turn or not. The wait
				// also lets every Turn end before the Chat goes.
				yield* message({
					user: "UBOB",
					text: "one more message",
					channel: "DUBOB",
					direct: true,
					id: "EvAfterDuplicate",
				})
				const texts = yield* until(
					"the message after the duplicate",
					Effect.gen(function* () {
						const page = yield* Caller.read(
							ItemPage,
							send(
								alice.session,
								"/v1/chats/" + firstChat + "/items?limit=100",
							),
							200,
						)
						const contents = yield* Effect.forEach(page.items, (item) =>
							encodeJson(item.content),
						)
						const turns = yield* turnsOf(firstChat)
						return Option.liftPredicate(
							contents,
							(all) =>
								Arr.some(all, Str.includes("one more message")) &&
								Arr.every(turns, (turn) => turn.status._tag !== "Running"),
						)
					}),
				)
				assert.strictEqual(
					Arr.filter(texts, Str.includes("hello again")).length,
					1,
				)

				// The actor deletes the Chat. The next message in that chat starts a new Chat.
				assert.strictEqual(
					(yield* send(alice.session, "/v1/chats/" + firstChat, "DELETE", {
						commandKey: "delete-chat",
					})).status,
					202,
				)
				yield* until(
					"the Chat is deleted",
					send(alice.session, "/v1/chats/" + firstChat).pipe(
						Effect.map((reply) =>
							Option.liftPredicate(
								reply,
								(response) => response.status === 404,
							),
						),
					),
				)
				yield* message({
					user: "UBOB",
					text: "hello after the delete",
					channel: "DUBOB",
					direct: true,
					id: "EvAfterDelete",
				})
				const direct = yield* until(
					"a new Chat for the chat",
					Effect.gen(function* () {
						const fresh = Arr.findFirst(
							yield* channelChats,
							(entry) => entry.chat.id !== firstChat,
						)
						if (Option.isNone(fresh)) return fresh
						const turns = yield* turnsOf(fresh.value.chat.id)
						return Option.filter(
							fresh,
							() =>
								turns.length === 1 &&
								Arr.every(turns, (turn) => turn.status._tag === "Completed"),
						)
					}),
				)
				assert.strictEqual((yield* channelChats).length, 1)

				// A group message that names the bot starts the Chat of that group.
				// The tool needs approval, and the card goes to Bob, who spoke.
				yield* message({
					user: "UBOB",
					text: "change this with approval",
					channel: "CTEAM",
					direct: false,
				})
				const card = yield* until(
					"the request card",
					findCall(
						(call) =>
							call.method === "chat.postMessage" &&
							call.body["channel"] === "UBOB" &&
							Option.exists(call.blocks, Str.includes("Allow once")),
					),
				)
				assert.match(
					String(card.body["text"]),
					/Team Bot\*\* wants to use the tool `ConfirmChange`/,
				)
				const once = pipe(
					card.blocks,
					Option.flatMap(Str.match(/"value":"(req_[^"]+ once \d+)"/)),
					Option.flatMap(Arr.get(1)),
				)
				assert.ok(Option.isSome(once))
				const pending = yield* Caller.read(
					Schema.Array(RequestsApi.CapabilityRequest),
					send(bob.session, "/v1/requests?status=pending"),
					200,
				)
				assert.strictEqual(pending.length, 1)
				assert.strictEqual(
					(yield* Caller.read(
						Schema.Array(RequestsApi.CapabilityRequest),
						send(alice.session, "/v1/requests?status=pending"),
						200,
					)).length,
					0,
				)

				// A person who is not linked cannot press it.
				yield* action("UEVE", once.value)
				yield* until(
					"the link prompt for Eve",
					findCall(
						(call) =>
							call.method === "chat.postMessage" &&
							call.body["channel"] === "DUEVE",
					),
				)
				// The Turn does not wait for the decision: the call is pending, and the Bot answers.
				// Bob allows it once. Then the call runs, and the card shows the decision.
				assert.strictEqual(yield* host.toolCalls, 0)
				yield* action("UBOB", once.value)
				yield* until(
					"the answer in the group",
					// The answer changes the message that showed the waiting Turn.
					findCall(
						(call) =>
							call.body["channel"] === "CTEAM" &&
							Str.includes("A useful result")(String(call.body["text"])),
					),
				)
				yield* until(
					"the decided card",
					findCall(
						(call) =>
							call.method === "chat.update" &&
							call.body["channel"] === "DUBOB" &&
							Str.includes("Allowed once.")(String(call.body["text"])),
					),
				)
				const group = Arr.findFirst(
					yield* channelChats,
					(entry) => entry.chat.id !== direct.chat.id,
				)
				assert.ok(Option.isSome(group))
				const groupTurn = Arr.head(yield* turnsOf(group.value.chat.id))
				assert.ok(Option.isSome(groupTurn))
				yield* checkSpeaker(groupTurn.value)
				yield* until(
					"the allowed call",
					Effect.map(
						host.toolCalls,
						Option.liftPredicate((count) => count === 1),
					),
				)

				yield* until(
					"the answer after the approved tool",
					findCall(
						(call) =>
							call.method === "chat.update" &&
							call.body["channel"] === "CTEAM" &&
							Str.includes("A useful result")(String(call.body["text"])),
					),
				)

				// An administrator can unlink a person. Then the bot asks again.
				assert.strictEqual(
					(yield* send(
						alice.session,
						`/v1/organization/channels/${channel.id}/identities/UBOB`,
						"DELETE",
					)).status,
					204,
				)
				assert.strictEqual(
					(yield* Caller.read(
						Schema.Array(ChannelsApi.ChannelIdentity),
						send(
							alice.session,
							`/v1/organization/channels/${channel.id}/identities`,
						),
						200,
					)).length,
					0,
				)

				// A restart reads terminal execution records and sends no saved result twice.
				const settled = host.run(
					ChannelPlatformScenarios.channelWorkSettled(
						alice.identity.organizationId,
					),
				)
				yield* until("Channel work to end", settled)
				const sentBefore = (yield* Ref.get(slack)).length
				yield* host.restart
				yield* until("saved Channel work after restart", settled)
				assert.strictEqual((yield* Ref.get(slack)).length, sentBefore)
			}),
		{ timeout: 180000 },
	)

	it.effect(
		"Telegram, Lark and custom Channels check their own secrets",
		() =>
			Effect.gen(function* () {
				const telegram = yield* Ref.make<ReadonlyArray<PlatformCall>>([])
				// The test plays Telegram.
				const platformFetch = (request: Request) =>
					Effect.gen(function* () {
						const url = new URL(request.url)
						assert.strictEqual(url.origin, "https://api.telegram.org")
						const body = yield* decodeBody(
							yield* Effect.promise(() => request.text()),
						)
						const calls = yield* Ref.updateAndGet(
							telegram,
							Arr.append({
								method: Arr.lastNonEmpty(Str.split("/")(url.pathname)),
								body,
							}),
						)
						return Response.json({
							ok: true,
							result: { message_id: calls.length },
						})
					}).pipe(Effect.orDie)
				const deliveries = yield* Ref.make<ReadonlyArray<Body>>([])
				// The custom endpoint is a fake network that keeps each delivery.
				const appNetwork = Layer.succeed(AppHost.AppNetwork, {
					layer: (owner) =>
						Layer.succeed(Network, {
							identity: { scope: "user", owner },
							execute: (request) =>
								Effect.gen(function* () {
									const body = yield* decodeBody(
										request.body._tag === "Uint8Array"
											? new TextDecoder().decode(request.body.body)
											: "",
									)
									const delivered = yield* Ref.updateAndGet(
										deliveries,
										Arr.append({
											url: request.url,
											signature: request.headers["x-openbot-signature"],
											...body,
										}),
									)
									const reply = yield* encodeJson({
										ref: "m" + delivered.length,
									})
									return {
										url: request.url,
										status: 200,
										headers: {},
										body: Stream.make(new TextEncoder().encode(reply)),
									}
								}),
							readDocument: () => Effect.die("not used"),
						}),
				})
				const host = yield* BrowserHost.start({
					publicOrigin,
					appNetwork,
					platformFetch,
				})
				const address = yield* host.address
				const send = Caller.withCookie({ address, publicOrigin })
				const alice = yield* host.login("kinds-alice")
				const bot = yield* sharedBot(send, alice.session)
				const create = (credentials: {
					readonly kind: string
					readonly [key: string]: unknown
				}) =>
					Caller.read(
						ChannelsApi.Channel,
						send(alice.session, "/v1/organization/channels", "POST", {
							commandKey: "channel:" + credentials.kind,
							name: "Bot",
							bot,
							credentials,
						}),
						201,
					)
				const hook = (
					id: string,
					body: string,
					headers: Record<string, string>,
				) =>
					post(
						address + "/v1/hooks/channels/" + id,
						body,
						"application/json",
						headers,
					)

				// OpenBot gives Telegram the webhook and a secret. Telegram sends the secret back.
				const channel = yield* create({
					kind: "telegram",
					botToken: "123456:telegram-token",
				})
				const registered = yield* until(
					"the webhook is registered",
					Ref.get(telegram).pipe(
						Effect.map(Arr.findFirst((call) => call.method === "setWebhook")),
					),
				)
				assert.strictEqual(registered.body["url"], channel.webhookUrl)
				const secret = String(registered.body["secret_token"])
				const update = yield* encodeJson({
					update_id: 1,
					message: {
						message_id: 1,
						chat: { id: 77, type: "private" },
						from: { id: 77, first_name: "Tom" },
						text: "hi",
					},
				})
				assert.strictEqual(
					(yield* hook(channel.id, update, {
						"x-telegram-bot-api-secret-token": "wrong",
					})).status,
					401,
				)
				assert.strictEqual(
					(yield* hook(channel.id, update, {
						"x-telegram-bot-api-secret-token": secret,
					})).status,
					200,
				)
				const prompt = yield* until(
					"the Telegram link prompt",
					Effect.map(
						Ref.get(telegram),
						Arr.findFirst((call) => call.method === "sendMessage"),
					),
				)
				assert.strictEqual(prompt.body["chat_id"], "77")
				assert.match(String(prompt.body["text"]), /<code>ocl_/)

				// Lark encrypts its events. The check of the request URL has the token.
				const encryptKey = "lark-encrypt-key"
				const lark = yield* create({
					kind: "lark",
					domain: "feishu",
					appId: "cli_test",
					appSecret: "lark-app-secret",
					verificationToken: "lark-token",
					encryptKey,
				})
				const crypto = yield* Crypto.Crypto
				const larkKey = yield* crypto.digest(
					"SHA-256",
					new TextEncoder().encode(encryptKey),
				)
				const encrypt = (value: unknown) =>
					Effect.gen(function* () {
						const iv = yield* crypto.randomBytes(16)
						const cipher = createCipheriv("aes-256-cbc", larkKey, iv)
						const encrypted = Buffer.concat([
							iv,
							cipher.update(yield* encodeJson(value)),
							cipher.final(),
						])
						return yield* encodeJson({ encrypt: encrypted.toString("base64") })
					})
				assert.deepStrictEqual(
					yield* Caller.read(
						Schema.Json,
						hook(
							lark.id,
							yield* encrypt({
								type: "url_verification",
								challenge: "lark-c",
								token: "lark-token",
							}),
							{},
						),
						200,
					),
					{ challenge: "lark-c" },
				)
				assert.strictEqual(
					(yield* hook(
						lark.id,
						yield* encrypt({
							type: "url_verification",
							challenge: "x",
							token: "wrong",
						}),
						{},
					)).status,
					401,
				)

				// A custom Channel signs both ways with the secret that OpenBot made.
				const custom = yield* create({
					kind: "custom",
					endpoint: "https://custom.example.com/hook",
				})
				const body = yield* encodeJson({
					type: "message",
					id: "e1",
					conversation: { id: "room-1", kind: "group" },
					sender: { id: "u1", name: "Uma" },
					text: "hello",
					mentioned: true,
				})
				const timestamp = String(
					Math.floor((yield* Clock.currentTimeMillis) / 1000),
				)
				const sign = (key: string) =>
					"sha256=" +
					createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex")
				// Without a secret, nothing gets in.
				assert.strictEqual(
					(yield* hook(custom.id, body, {
						"x-openbot-timestamp": timestamp,
						"x-openbot-signature": sign("none"),
					})).status,
					401,
				)
				const { secret: customSecret } = yield* Caller.read(
					ChannelsApi.ChannelSecret,
					send(
						alice.session,
						`/v1/organization/channels/${custom.id}/secret`,
						"PUT",
						{ commandKey: "channel-secret", expectedVersion: custom.version },
					),
					200,
				)
				assert.strictEqual(
					(yield* hook(custom.id, body, {
						"x-openbot-timestamp": timestamp,
						"x-openbot-signature": sign("wrong"),
					})).status,
					401,
				)
				assert.strictEqual(
					(yield* hook(custom.id, body, {
						"x-openbot-timestamp": timestamp,
						"x-openbot-signature": sign(Redacted.value(customSecret)),
					})).status,
					200,
				)
				const delivery = yield* until(
					"the custom link prompt",
					Effect.map(
						Ref.get(deliveries),
						Arr.findFirst((entry) => entry["type"] === "send"),
					),
				)
				// In a group, the prompt goes privately to the sender.
				assert.strictEqual(delivery["conversation"], "room-1")
				assert.strictEqual(delivery["person"], "u1")
				assert.strictEqual(delivery["url"], "https://custom.example.com/hook")
				assert.match(String(delivery["signature"]), /^sha256=[0-9a-f]{64}$/)
				const listedResponse = yield* send(
					alice.session,
					"/v1/organization/channels",
				)
				const listed = yield* Caller.json(
					Schema.Array(ChannelsApi.Channel),
					200,
				)(listedResponse)
				assert.deepStrictEqual(
					Arr.map(listed, (entry) => entry.kind),
					["telegram", "lark", "custom"],
				)
				assert.notMatch(
					yield* listedResponse.text,
					/telegram-token|lark-app-secret|ocs_/,
				)
				const token = yield* Caller.read(
					UserTokensApi.CreatedToken,
					send(alice.session, "/v1/user/tokens", "POST", {
						name: "Channel removal",
					}),
					201,
				)
				const keyed = Caller.withToken(address)
				for (const useToken of [false, true]) {
					const id = useToken ? channel.id : custom.id
					const call = (
						path: string,
						method: "GET" | "DELETE" = "GET",
						payload?: unknown,
					) =>
						useToken
							? keyed(token.secret, path, method, payload)
							: send(alice.session, path, method, payload)
					const path = "/v1/organization/channels/" + id
					const command = { commandKey: "channel-delete:" + id }
					const receipt = yield* Caller.read(
						Execution.Receipt,
						call(path, "DELETE", command),
						202,
					)
					const ended = yield* Wait.untilTrue(
						"Channel removal ends",
						Caller.read(
							Execution.Record,
							call("/v1/executions/" + receipt.executionId),
							200,
						),
						(record) => Execution.isTerminal(record.status),
					)
					assert.strictEqual(ended.status, "completed")
					assert.strictEqual((yield* call(path)).status, 404)
					assert.deepStrictEqual(
						yield* Caller.read(
							Execution.Receipt,
							call(path, "DELETE", command),
							202,
						),
						receipt,
					)
				}
			}),
		{ timeout: 120000 },
	)

	it.effect(
		"Channel registration keeps configuration and records rejected and unknown results",
		() =>
			Effect.gen(function* () {
				// The test plays Telegram. It refuses one token, and it is down for the other.
				const platformFetch = (request: Request) =>
					Effect.succeed(
						Str.includes("refused-token")(request.url)
							? Response.json(
									{ ok: false, description: "Bad Request: bad webhook" },
									{ status: 400 },
								)
							: Response.json(
									{ ok: false, description: "Bad Gateway" },
									{ status: 502 },
								),
					)
				const host = yield* BrowserHost.start({ publicOrigin, platformFetch })
				const address = yield* host.address
				const send = Caller.withCookie({ address, publicOrigin })
				const alice = yield* host.login("refused-alice")
				const bot = yield* sharedBot(send, alice.session)
				const create = (botToken: string) =>
					send(alice.session, "/v1/organization/channels", "POST", {
						commandKey: "channel:" + botToken,
						name: "Bot",
						bot,
						credentials: { kind: "telegram", botToken },
					})

				const refused = yield* Caller.read(
					ChannelsApi.Channel,
					create("123456:refused-token"),
					201,
				)
				const down = yield* Caller.read(
					ChannelsApi.Channel,
					create("123456:down-token"),
					201,
				)
				const state = (
					channel: ChannelsApi.Channel,
					status: Execution.Status,
				) =>
					until(
						"the registration result",
						Caller.read(
							Execution.Record,
							send(alice.session, "/v1/executions/" + channel.executionId),
						).pipe(
							Effect.map((record) =>
								record.status === status ? Option.some(record) : Option.none(),
							),
						),
					)
				const failed = yield* state(refused, "failed")
				assert.strictEqual(failed.failure?.category, "invalid")
				assert.ok(failed.failure?.errorId)
				yield* state(down, "outcome_unknown")
				assert.deepStrictEqual(
					yield* Caller.read(
						ChannelsApi.Channel,
						create("123456:refused-token"),
						201,
					),
					refused,
				)
				const listed = yield* Caller.read(
					Schema.Array(ChannelsApi.Channel),
					send(alice.session, "/v1/organization/channels"),
				)
				assert.deepStrictEqual(
					Arr.map(listed, (channel) => channel.id),
					[refused.id, down.id],
				)
				const raw = yield* host.run(
					ChannelPlatformScenarios.registrationCallStatuses(
						refused.executionId!,
						alice.identity.organizationId,
					),
				)
				assert.strictEqual(raw.length, 1)
				assert.strictEqual(raw[0], "completed")
			}),
		{ timeout: 120000 },
	)
})
