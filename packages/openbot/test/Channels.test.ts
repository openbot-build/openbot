import {
	createCipheriv,
	createHash,
	createHmac,
	randomBytes,
} from "node:crypto"
import { assert, it } from "@effect/vitest"
import { ChannelsApi } from "@openbot-build/api"
import { Network } from "@openbot-build/protocol/Network"
import { Effect, Layer, Redacted, Stream } from "effect"
import { AppNetwork } from "../src/apps/AppHost.ts"
import { chunk, slackMrkdwn, telegramHtml } from "../src/channels/Text.ts"
import * as BrowserHost from "./BrowserHost.ts"

const publicOrigin = "https://channels.example.com"

type Host = Awaited<ReturnType<typeof BrowserHost.start>>

const client = (host: Host) => {
	const send = (
		credential: Redacted.Redacted<string> | undefined,
		path: string,
		method = "GET",
		payload?: unknown,
	) =>
		fetch(host.address + path, {
			method,
			headers: {
				...(credential === undefined
					? {}
					: {
							cookie:
								"__Host-openbot-session=" +
								encodeURIComponent(Redacted.value(credential)),
						}),
				origin: publicOrigin,
				...(payload === undefined
					? {}
					: { "content-type": "application/json" }),
			},
			...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
		})
	const json = async (response: Promise<Response>, status = 200) => {
		const value = await response
		const body = await value.text()
		assert.strictEqual(value.status, status, body)
		return body.length === 0 ? undefined : JSON.parse(body)
	}
	const until = async <A>(
		label: string,
		check: () => A | undefined | Promise<A | undefined>,
	): Promise<A> => {
		for (let tries = 0; tries < 600; tries++) {
			const value = await check()
			if (value !== undefined) return value
			await new Promise((resolve) => setTimeout(resolve, 25))
		}
		throw new Error("Timed out: " + label)
	}
	return { send, json, until }
}

const sharedBot = async (host: Host, owner: Redacted.Redacted<string>) => {
	const { send, json } = client(host)
	const bot = await json(
		send(owner, "/v1/bots", "POST", {
			name: "Team Bot",
			role: "Helps the team in chat",
			instructions: "Answer short.",
			shared: true,
		}),
		201,
	)
	return bot.id as string
}

it("Markdown turns into the format of each platform, and long text splits at words", () => {
	assert.strictEqual(
		slackMrkdwn("**bold** and [site](https://a.example)"),
		"*bold* and <https://a.example|site>",
	)
	assert.strictEqual(slackMrkdwn("a < b"), "a &lt; b")
	assert.strictEqual(
		telegramHtml("# Title\n**bold** `x<y`\n```\nif (a < b) {}\n```"),
		"<b>Title</b>\n<b>bold</b> <code>x&lt;y</code>\n<pre>if (a &lt; b) {}\n</pre>",
	)
	assert.deepStrictEqual(chunk("one two three four", 9), [
		"one two",
		"three",
		"four",
	])
	assert.deepStrictEqual(chunk("short", 10), ["short"])
})

it(
	"a Slack Channel links people, keeps one Chat for each chat, works for the speaker, and decides requests with buttons",
	{ timeout: 180000 },
	async () => {
		const signingSecret = "slack-signing-secret-for-tests"
		type Call = {
			readonly method: string
			readonly body: Record<string, unknown>
		}
		const slack: Array<Call> = []
		let ts = 0
		// The test plays Slack.
		const platformFetch: typeof fetch = async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : String(input))
			assert.strictEqual(url.origin, "https://slack.com")
			const request = input instanceof Request ? input : new Request(url, init)
			assert.strictEqual(
				request.headers.get("authorization"),
				"Bearer xoxb-test-token-123456",
			)
			const body = (await request.json()) as Record<string, unknown>
			const method = url.pathname.replace("/api/", "")
			slack.push({ method, body })
			ts++
			const channel = String(body["channel"])
			return Response.json({
				ok: true,
				channel: channel.startsWith("U") ? "D" + channel : channel,
				ts: String(ts),
				message_ts: String(ts),
			})
		}
		const host = await BrowserHost.start({
			publicOrigin,
			channelIntervalMs: 40,
			platformFetch,
		})
		try {
			const { send, json, until } = client(host)
			const alice = await host.login("channels-alice")
			const bob = await host.login("channels-bob")
			const bot = await sharedBot(host, alice.session)

			// Only administrators manage Channels. Secrets never come back.
			const payload = {
				name: "Team Slack",
				bot,
				linkPath: "/link",
				credentials: {
					kind: "slack",
					botToken: "xoxb-test-token-123456",
					signingSecret,
				},
			}
			const refused = await send(
				bob.session,
				"/v1/organization/channels",
				"POST",
				payload,
			)
			assert.strictEqual(refused.status, 403)
			const created = await json(
				send(alice.session, "/v1/organization/channels", "POST", payload),
				201,
			)
			const channel = created as ChannelsApi.Channel
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
			assert.notMatch(JSON.stringify(created), /xoxb-test-token|signing-secret/)
			const mine = await json(
				send(alice.session, "/v1/bots", "POST", {
					name: "Private Bot",
					role: "Mine",
					instructions: "Help me.",
				}),
				201,
			)
			const wrongBot = await send(
				alice.session,
				"/v1/organization/channels",
				"POST",
				{
					...payload,
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
			) => {
				const timestamp = String(
					Math.floor(Date.now() / 1000) - (options.age ?? 0),
				)
				const signature =
					"v0=" +
					createHmac("sha256", options.secret ?? signingSecret)
						.update(`v0:${timestamp}:${body}`)
						.digest("hex")
				return fetch(host.address + "/v1/hooks/channels/" + channel.id, {
					method: "POST",
					headers: {
						"content-type":
							options.form === true
								? "application/x-www-form-urlencoded"
								: "application/json",
						"x-slack-request-timestamp": timestamp,
						"x-slack-signature": signature,
					},
					body,
				})
			}
			const verification = JSON.stringify({
				type: "url_verification",
				challenge: "c-123",
			})
			assert.deepStrictEqual(await json(hook(verification)), {
				challenge: "c-123",
			})
			assert.strictEqual(
				(await hook(verification, { secret: "wrong" })).status,
				401,
			)
			assert.strictEqual((await hook(verification, { age: 600 })).status, 401)

			let events = 0
			const message = (input: {
				readonly user: string
				readonly text: string
				readonly channel: string
				readonly direct: boolean
				readonly id?: string
			}) => {
				events++
				return hook(
					JSON.stringify({
						type: "event_callback",
						event_id: input.id ?? "Ev" + events,
						event: {
							type: input.direct ? "message" : "app_mention",
							channel_type: input.direct ? "im" : "channel",
							channel: input.channel,
							user: input.user,
							text: input.text,
							ts: String(events),
						},
					}),
				)
			}
			const action = (user: string, value: string) =>
				hook(
					"payload=" +
						encodeURIComponent(
							JSON.stringify({
								type: "block_actions",
								trigger_id: "trigger-" + Math.random(),
								user: { id: user, name: user },
								channel: { id: "D" + user },
								actions: [{ action_ts: String(Date.now()), value }],
							}),
						),
					{ form: true },
				)
			const channelChats = async () =>
				(await json(
					send(alice.session, "/v1/chats?kind=channel"),
				)) as ReadonlyArray<{ readonly chat: { readonly id: string } }>
			const turnsOf = async (chat: string) =>
				(
					(await json(send(alice.session, "/v1/chats/" + chat + "/turns"))) as {
						readonly items: ReadonlyArray<{
							readonly author?: string
							readonly status: { readonly _tag: string }
						}>
					}
				).items

			// A person who is not linked gets a link in the direct chat, and nothing runs.
			assert.strictEqual(
				(
					await message({
						user: "UBOB",
						text: "hello",
						channel: "DUBOB",
						direct: true,
					})
				).status,
				200,
			)
			const prompt = await until("the link prompt", () =>
				slack.find(
					(call) =>
						call.method === "chat.postMessage" &&
						String(call.body["text"]).includes("/link?code="),
				),
			)
			assert.strictEqual(prompt.body["channel"], "DUBOB")
			const code = decodeURIComponent(
				/code=([^\s)]+)/.exec(String(prompt.body["text"]))![1]!,
			)
			assert.strictEqual((await channelChats()).length, 0)

			// The person opens the link in OpenBot and accepts it. A code works once.
			const link = await json(
				send(bob.session, "/v1/channel-links/" + encodeURIComponent(code)),
			)
			assert.strictEqual(link.externalUserId, "UBOB")
			assert.strictEqual(link.channelName, "Team Slack")
			const linked = await json(
				send(
					bob.session,
					"/v1/channel-links/" + encodeURIComponent(code) + "/accept",
					"POST",
				),
			)
			assert.strictEqual(linked.userId, bob.identity.userId)
			assert.strictEqual(
				(
					await send(
						bob.session,
						"/v1/channel-links/" + encodeURIComponent(code) + "/accept",
						"POST",
					)
				).status,
				404,
			)
			assert.strictEqual(
				(await json(send(bob.session, "/v1/user/channel-identities"))).length,
				1,
			)

			// Now the Bot answers. The Chat belongs to the actor, and the Turn works for Bob.
			await message({
				user: "UBOB",
				text: "hello again",
				channel: "DUBOB",
				direct: true,
				id: "EvSame",
			})
			const answer = await until("the answer in Slack", () =>
				slack.find(
					(call) =>
						call.method === "chat.update" &&
						String(call.body["text"]).includes("A useful result"),
				),
			)
			assert.strictEqual(answer.body["channel"], "DUBOB")
			assert.ok(
				slack.some(
					(call) =>
						call.method === "chat.postMessage" &&
						call.body["text"] === "Working…",
				),
			)
			const [first] = await channelChats()
			assert.ok(first !== undefined)
			let direct = first
			assert.strictEqual(
				(await turnsOf(direct.chat.id)).at(-1)?.author,
				bob.identity.userId,
			)
			// Slack sends an event again when it is not sure. It runs only once.
			await message({
				user: "UBOB",
				text: "hello again",
				channel: "DUBOB",
				direct: true,
				id: "EvSame",
			})
			await new Promise((resolve) => setTimeout(resolve, 400))
			assert.strictEqual((await turnsOf(direct.chat.id)).length, 1)

			// The actor deletes the Chat. The next message in that chat starts a new Chat.
			assert.strictEqual(
				(await send(alice.session, "/v1/chats/" + direct.chat.id, "DELETE"))
					.status,
				204,
			)
			await message({
				user: "UBOB",
				text: "hello after the delete",
				channel: "DUBOB",
				direct: true,
				id: "EvAfterDelete",
			})
			direct = await until("a new Chat for the chat", async () => {
				const list = await channelChats()
				const fresh = list.find((entry) => entry.chat.id !== first.chat.id)
				if (fresh === undefined) return undefined
				const turns = await turnsOf(fresh.chat.id)
				return turns.length === 1 && turns[0]?.status._tag === "Completed"
					? fresh
					: undefined
			})
			assert.strictEqual((await channelChats()).length, 1)

			// A group message that names the bot starts the Chat of that group.
			// The tool needs approval, and the card goes to Bob, who spoke.
			await message({
				user: "UBOB",
				text: "change this with approval",
				channel: "CTEAM",
				direct: false,
			})
			const card = await until("the request card", () =>
				slack.find(
					(call) =>
						call.method === "chat.postMessage" &&
						call.body["channel"] === "UBOB" &&
						Array.isArray(call.body["blocks"]) &&
						JSON.stringify(call.body["blocks"]).includes("Allow once"),
				),
			)
			assert.match(
				String(card.body["text"]),
				/Team Bot\*\* wants to use the tool `ConfirmChange`/,
			)
			const values = JSON.stringify(card.body["blocks"]).match(
				/"value":"(req_[^"]+ once \d+)"/,
			)
			assert.ok(values !== null)
			const pending = await json(
				send(bob.session, "/v1/requests?status=pending"),
			)
			assert.strictEqual(pending.length, 1)
			assert.strictEqual(
				(await json(send(alice.session, "/v1/requests?status=pending"))).length,
				0,
			)

			// A person who is not linked cannot press it.
			await action("UEVE", values[1]!)
			await until("the link prompt for Eve", () =>
				slack.find(
					(call) =>
						call.method === "chat.postMessage" &&
						call.body["channel"] === "DUEVE",
				),
			)
			// The Turn does not wait for the decision: the call is pending, and the Bot answers.
			// Bob allows it once. Then the call runs, and the card shows the decision.
			assert.strictEqual(host.toolCalls(), 0)
			await action("UBOB", values[1]!)
			await until("the answer in the group", () =>
				// The answer changes the message that showed the waiting Turn.
				slack.find(
					(call) =>
						call.body["channel"] === "CTEAM" &&
						String(call.body["text"]).includes("A useful result"),
				),
			)
			await until("the decided card", () =>
				slack.find(
					(call) =>
						call.method === "chat.update" &&
						call.body["channel"] === "DUBOB" &&
						String(call.body["text"]).includes("Allowed once."),
				),
			)
			const group = (await channelChats()).find(
				(entry) => entry.chat.id !== direct.chat.id,
			)
			assert.ok(group !== undefined)
			assert.strictEqual(
				(await turnsOf(group.chat.id))[0]?.author,
				bob.identity.userId,
			)
			await until("the allowed call", async () =>
				host.toolCalls() === 1 ? true : undefined,
			)

			// An administrator can unlink a person. Then the bot asks again.
			assert.strictEqual(
				(
					await send(
						alice.session,
						`/v1/organization/channels/${channel.id}/identities/UBOB`,
						"DELETE",
					)
				).status,
				204,
			)
			assert.strictEqual(
				(
					await json(
						send(
							alice.session,
							`/v1/organization/channels/${channel.id}/identities`,
						),
					)
				).length,
				0,
			)
		} finally {
			await host.close()
		}
	},
)

it(
	"Telegram, Lark and custom Channels check their own secrets",
	{ timeout: 120000 },
	async () => {
		const telegram: Array<{
			readonly method: string
			readonly body: Record<string, unknown>
		}> = []
		// The test plays Telegram.
		const platformFetch: typeof fetch = async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : String(input))
			assert.strictEqual(url.origin, "https://api.telegram.org")
			const request = input instanceof Request ? input : new Request(url, init)
			const body = (await request.json()) as Record<string, unknown>
			telegram.push({ method: url.pathname.split("/").at(-1)!, body })
			return Response.json({
				ok: true,
				result: { message_id: telegram.length },
			})
		}
		const deliveries: Array<Record<string, unknown>> = []
		// The custom endpoint is a fake network that keeps each delivery.
		const appNetwork = Layer.succeed(AppNetwork, {
			layer: (owner) =>
				Layer.succeed(Network, {
					identity: { scope: "user", owner },
					execute: (request) =>
						Effect.sync(() => {
							const body =
								request.body._tag === "Uint8Array"
									? new TextDecoder().decode(request.body.body)
									: ""
							deliveries.push({
								url: request.url,
								signature: request.headers["x-openbot-signature"],
								...JSON.parse(body),
							})
							return {
								url: request.url,
								status: 200,
								headers: {},
								body: Stream.make(
									new TextEncoder().encode(
										JSON.stringify({ ref: "m" + deliveries.length }),
									),
								),
							}
						}),
					readDocument: () => Effect.die("not used"),
				}),
		})
		const host = await BrowserHost.start({
			publicOrigin,
			channelIntervalMs: 40,
			appNetwork,
			platformFetch,
		})
		try {
			const { send, json, until } = client(host)
			const alice = await host.login("kinds-alice")
			const bot = await sharedBot(host, alice.session)
			const create = (credentials: unknown) =>
				json(
					send(alice.session, "/v1/organization/channels", "POST", {
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
				fetch(host.address + "/v1/hooks/channels/" + id, {
					method: "POST",
					headers: { "content-type": "application/json", ...headers },
					body,
				})

			// OpenBot gives Telegram the webhook and a secret. Telegram sends the secret back.
			const channel = await create({
				kind: "telegram",
				botToken: "123456:telegram-token",
			})
			const registered = telegram.find((call) => call.method === "setWebhook")
			assert.ok(registered !== undefined)
			assert.strictEqual(registered.body["url"], channel.webhookUrl)
			const secret = String(registered.body["secret_token"])
			const update = JSON.stringify({
				update_id: 1,
				message: {
					message_id: 1,
					chat: { id: 77, type: "private" },
					from: { id: 77, first_name: "Tom" },
					text: "hi",
				},
			})
			assert.strictEqual(
				(
					await hook(channel.id, update, {
						"x-telegram-bot-api-secret-token": "wrong",
					})
				).status,
				401,
			)
			assert.strictEqual(
				(
					await hook(channel.id, update, {
						"x-telegram-bot-api-secret-token": secret,
					})
				).status,
				200,
			)
			const prompt = await until("the Telegram link prompt", () =>
				telegram.find((call) => call.method === "sendMessage"),
			)
			assert.strictEqual(prompt.body["chat_id"], "77")
			assert.match(String(prompt.body["text"]), /<code>ocl_/)

			// Lark encrypts its events. The check of the request URL has the token.
			const encryptKey = "lark-encrypt-key"
			const lark = await create({
				kind: "lark",
				domain: "feishu",
				appId: "cli_test",
				appSecret: "lark-app-secret",
				verificationToken: "lark-token",
				encryptKey,
			})
			const encrypt = (value: unknown) => {
				const iv = randomBytes(16)
				const cipher = createCipheriv(
					"aes-256-cbc",
					createHash("sha256").update(encryptKey).digest(),
					iv,
				)
				return JSON.stringify({
					encrypt: Buffer.concat([
						iv,
						cipher.update(JSON.stringify(value)),
						cipher.final(),
					]).toString("base64"),
				})
			}
			assert.deepStrictEqual(
				await json(
					hook(
						lark.id,
						encrypt({
							type: "url_verification",
							challenge: "lark-c",
							token: "lark-token",
						}),
						{},
					),
				),
				{ challenge: "lark-c" },
			)
			assert.strictEqual(
				(
					await hook(
						lark.id,
						encrypt({
							type: "url_verification",
							challenge: "x",
							token: "wrong",
						}),
						{},
					)
				).status,
				401,
			)

			// A custom Channel signs both ways with the secret that OpenBot made.
			const custom = await create({
				kind: "custom",
				endpoint: "https://custom.example.com/hook",
			})
			const body = JSON.stringify({
				type: "message",
				id: "e1",
				conversation: { id: "room-1", kind: "group" },
				sender: { id: "u1", name: "Uma" },
				text: "hello",
				mentioned: true,
			})
			const timestamp = String(Math.floor(Date.now() / 1000))
			const sign = (key: string) =>
				"sha256=" +
				createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex")
			// Without a secret, nothing gets in.
			assert.strictEqual(
				(
					await hook(custom.id, body, {
						"x-openbot-timestamp": timestamp,
						"x-openbot-signature": sign("none"),
					})
				).status,
				401,
			)
			const { secret: customSecret } = await json(
				send(
					alice.session,
					`/v1/organization/channels/${custom.id}/secret`,
					"PUT",
				),
			)
			assert.strictEqual(
				(
					await hook(custom.id, body, {
						"x-openbot-timestamp": timestamp,
						"x-openbot-signature": sign("wrong"),
					})
				).status,
				401,
			)
			assert.strictEqual(
				(
					await hook(custom.id, body, {
						"x-openbot-timestamp": timestamp,
						"x-openbot-signature": sign(customSecret),
					})
				).status,
				200,
			)
			const delivery = await until("the custom link prompt", () =>
				deliveries.find((entry) => entry["type"] === "send"),
			)
			// In a group, the prompt goes privately to the sender.
			assert.strictEqual(delivery["conversation"], "room-1")
			assert.strictEqual(delivery["person"], "u1")
			assert.strictEqual(delivery["url"], "https://custom.example.com/hook")
			assert.match(String(delivery["signature"]), /^sha256=[0-9a-f]{64}$/)
			const listed = await json(
				send(alice.session, "/v1/organization/channels"),
			)
			assert.deepStrictEqual(
				listed.map((entry: { readonly kind: string }) => entry.kind),
				["telegram", "lark", "custom"],
			)
			assert.notMatch(
				JSON.stringify(listed),
				/telegram-token|lark-app-secret|ocs_/,
			)
		} finally {
			await host.close()
		}
	},
)
