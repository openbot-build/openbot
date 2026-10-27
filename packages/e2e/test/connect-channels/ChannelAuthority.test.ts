import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import { BotsApi, ChannelsApi, UserTokensApi } from "@openbot-build/api"
import { Effect, String as Str } from "effect"
import {
	BrowserHost,
	Caller,
	ChannelScenarios,
} from "@openbot-build/openbot/testing"

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"a Channel keeps the original token caller in its sealed configuration",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({
					publicOrigin: "https://channel-authority.example.com",
				})
				const alice = yield* host.login("channel-authority")
				const session = Caller.withCookie({
					address: yield* host.address,
					publicOrigin: "https://channel-authority.example.com",
				})
				const token = yield* Caller.read(
					UserTokensApi.CreatedToken,
					session(alice.session, "/v1/user/tokens", "POST", {
						name: "Channel token",
					}),
				)
				const keyed = Caller.withToken(yield* host.address)
				const bot = yield* Caller.read(
					BotsApi.Bot,
					session(alice.session, "/v1/bots", "POST", {
						name: "Team",
						role: "Helps people",
						instructions: "Help the team.",
						shared: true,
					}),
				)
				const channel = yield* keyed(
					token.secret,
					"/v1/organization/channels",
					"POST",
					{
						commandKey: "channel-authority",
						name: "Team",
						bot: bot.id,
						credentials: {
							kind: "custom",
							endpoint: "https://channel.example.com/hook",
						},
					},
				).pipe(Effect.flatMap(Caller.json(ChannelsApi.Channel, 201)))
				const read = host.run(
					ChannelScenarios.authority(alice.identity.organizationId, channel.id),
				)
				const caller = yield* read
				assert.strictEqual(caller.kind, "user_token")
				assert.strictEqual(caller.userId, alice.identity.userId)
				assert.ok(caller.tokenId !== undefined)
				const raw = yield* host.run(
					Effect.gen(function* () {
						const sql = yield* PgClient.PgClient
						return yield* sql<{
							credentials: string
						}>`select credentials from openbot_channels where id = ${channel.id}`
					}),
				)
				assert.ok(!Str.includes(caller.tokenId!)(raw[0]!.credentials))
				yield* host.restart
				assert.deepStrictEqual(yield* read, caller)
				const currentSession = Caller.withCookie({
					address: yield* host.address,
					publicOrigin: "https://channel-authority.example.com",
				})
				yield* Caller.read(
					ChannelsApi.Channel,
					currentSession(
						alice.session,
						"/v1/organization/channels/" + channel.id,
						"PATCH",
						{
							commandKey: "channel-authority-update",
							expectedVersion: channel.version,
							name: "New team",
						},
					),
				)
				assert.strictEqual((yield* read).kind, "member")
			}),
		60000,
	)
})
