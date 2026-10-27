import { changed, finished } from "./Commands.ts"
import { assert, layer } from "@effect/vitest"
import { ComputersApi, UserTokensApi } from "@openbot-build/api"
import {
	Authorization,
	BotId,
	type ExecutionIdentity,
} from "@openbot-build/domain"
import { Array as Arr, Effect, Schema } from "effect"
import {
	BrowserHost,
	Caller,
	ComputerScenarios,
	Policies,
} from "@openbot-build/openbot/testing"

const publicOrigin = "https://computer-reads.example.com"
layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"Computer lists apply every caller limit before decoding rows",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({ publicOrigin })
				const member = yield* host.login("computer-reader")
				const cookie = Caller.withCookie({
					address: yield* host.address,
					publicOrigin,
				})
				const tokenSend = Caller.withToken(yield* host.address)
				const fullToken = yield* cookie(
					member.session,
					"/v1/user/tokens",
					"POST",
					{ name: "Computer commands" },
				).pipe(Effect.flatMap(Caller.json(UserTokensApi.CreatedToken, 201)))
				const command = {
					commandKey: "connector-by-token",
					name: "Token box",
					source: { _tag: "Connector" },
				}
				const tokenBox = yield* changed(
					tokenSend,
					fullToken.secret,
					tokenSend(fullToken.secret, "/v1/computers", "POST", command),
				)
				const replay = yield* changed(
					tokenSend,
					fullToken.secret,
					tokenSend(fullToken.secret, "/v1/computers", "POST", command),
				)
				assert.equal(replay.id, tokenBox.id)
				yield* finished(
					tokenSend,
					fullToken.secret,
					tokenSend(
						fullToken.secret,
						`/v1/computers/${tokenBox.id}`,
						"DELETE",
						{ commandKey: "remove-token-box" },
					),
				)
				const made = yield* Effect.forEach(["first", "second"], (name) =>
					changed(
						cookie,
						member.session,
						cookie(member.session, "/v1/computers", "POST", {
							commandKey: "create:" + name,
							name,
							source: { _tag: "Connector" },
						}),
					),
				)
				const first = made[0]!
				const second = made[1]!
				const providerId = ComputersApi.ComputerProviderId.make("cpp_first")
				const bot = BotId.make("bot")
				yield* host.run(
					ComputerScenarios.prepareListRows(
						member.identity,
						made,
						bot,
						providerId,
						first.id,
						second.id,
					),
				)
				const token = yield* cookie(member.session, "/v1/user/tokens", "POST", {
					name: "Read one Computer",
					policy: yield* Policies.json(function* (_) {
						yield* _.allow("read", Authorization.Computer, {
							when: ($) => $.eq("id", first.id),
						})
						yield* _.allow("read", Authorization.ComputerProvider, {
							when: ($) => $.eq("id", providerId),
						})
					}),
				}).pipe(Effect.flatMap(Caller.json(UserTokensApi.CreatedToken, 201)))
				const identity: ExecutionIdentity = {
					owner: member.identity,
					actor: member.identity,
					constraints: [
						{ ...member.identity, kind: "user_token", tokenId: token.token.id },
					],
					botId: bot,
				}
				const listed = yield* host.run(
					ComputerScenarios.queryLists(identity, first.id),
				)
				assert.deepStrictEqual(
					Arr.map(listed.listed, (row) => row.id),
					[first.id],
				)
				assert.equal(listed.one.state, "offline")
				assert.equal(listed.listedAgain[0]?.state, "offline")
				assert.deepStrictEqual(
					Arr.map(listed.botListed, (row) => row.id),
					[first.id],
				)
				assert.deepStrictEqual(
					Arr.map(listed.providers, (row) => row.id),
					[providerId],
				)
				const direct = yield* tokenSend(token.secret, "/v1/computers").pipe(
					Effect.flatMap(Caller.json(Schema.Array(ComputersApi.Computer))),
				)
				assert.deepStrictEqual(
					Arr.map(direct, (row) => row.id),
					[first.id],
				)
				assert.equal(
					(yield* cookie(
						member.session,
						`/v1/user/tokens/${token.token.id}`,
						"DELETE",
					)).status,
					204,
				)
				const revoked = yield* host.run(
					ComputerScenarios.queryAfterRevoke(identity),
				)
				assert.deepStrictEqual(revoked.computers, [])
				assert.deepStrictEqual(revoked.providers, [])
			}),
	)
})
