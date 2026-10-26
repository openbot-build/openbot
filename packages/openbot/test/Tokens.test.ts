import { assert, layer } from "@effect/vitest"
import { PgClient } from "@effect/sql-pg"
import { Authorization, ChatView, UserTokensApi } from "@openbot-build/api"
import {
	Array as Arr,
	Clock,
	DateTime,
	Effect,
	Option,
	Schema,
	String as Str,
} from "effect"
import { Headers, type HttpClientResponse, HttpClient } from "effect/http"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import { message } from "./Messages.ts"
import * as Policies from "./Policies.ts"

const publicOrigin = "https://api.example.com"

const Root = Schema.Struct({ tokens: Schema.String })
const TokenList = Schema.Struct({ items: Schema.Array(UserTokensApi.Token) })

const decodeTagged = Schema.decodeUnknownEffect(
	Schema.Struct({ _tag: Schema.String }),
)

/** Gives the `_tag` of the JSON body of an answer. */
const tagOf = (response: HttpClientResponse.HttpClientResponse) =>
	Effect.map(Effect.flatMap(response.json, decodeTagged), (body) => body._tag)

/** Calls the API and reads the JSON body with a schema. The status must be 2xx, or `status` when given. */
const json = <S extends Schema.Constraint>(
	schema: S,
	call: Caller.Call,
	status?: number,
) => Effect.flatMap(call, Caller.json(schema, status))

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"User tokens authenticate headless clients, stay with their member and stop working when revoked",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({ publicOrigin })
				const alice = yield* host.login("alice")
				const bob = yield* host.login("bob")
				const bot = yield* host.defaultBot(alice.session)
				const address = yield* host.address
				const account = Caller.withCookie({ address, publicOrigin })
				const keyed = Caller.withToken(address)

				const root = yield* HttpClient.get(address + "/")
				assert.strictEqual(root.status, 200)
				assert.strictEqual(
					(yield* Caller.json(Root)(root)).tokens,
					"/v1/user/tokens",
				)

				const created = yield* account(
					alice.session,
					"/v1/user/tokens",
					"POST",
					{ name: "  CI pipeline  " },
				)
				assert.strictEqual(created.status, 201, yield* created.text)
				assert.strictEqual(
					Option.getOrNull(Headers.get(created.headers, "cache-control")),
					"no-store",
				)
				const { token, secret } = yield* Caller.json(
					UserTokensApi.CreatedToken,
				)(created)
				assert.match(secret, /^obut_[A-Za-z0-9_-]{43}$/)
				assert.strictEqual(token.name, "CI pipeline")
				assert.ok(Str.startsWith(token.prefix)(secret))
				assert.strictEqual(token.expiresAt, null)
				assert.strictEqual(token.lastUsedAt, null)

				const receipt = yield* message(
					(path, method, payload) => keyed(secret, path, method, payload),
					bot,
					"Headless work",
				)
				const listed = yield* keyed(secret, "/v1/chats")
				assert.strictEqual(listed.status, 200)
				assert.ok(Str.includes(receipt.chat)(yield* listed.text))
				// Members of one organization still do not see each other's Chats.
				assert.strictEqual(
					(yield* account(
						bob.session,
						"/v1/chats/" + encodeURIComponent(receipt.chat),
					)).status,
					404,
				)

				const verified = yield* json(
					UserTokensApi.TokenVerification,
					keyed(secret, "/v1/tokens/verify"),
				)
				assert.strictEqual(verified.caller.kind, "user_token")
				assert.strictEqual(verified.caller.userId, alice.identity.userId)
				assert.strictEqual(
					verified.caller.organizationId,
					alice.identity.organizationId,
				)
				assert.strictEqual(verified.token?.id, token.id)
				assert.strictEqual(
					(yield* json(
						UserTokensApi.TokenVerification,
						account(alice.session, "/v1/tokens/verify"),
					)).token,
					null,
				)

				const tokensResponse = yield* account(alice.session, "/v1/user/tokens")
				const tokens = yield* Caller.json(TokenList)(tokensResponse)
				assert.strictEqual(tokens.items.length, 1)
				assert.notStrictEqual(tokens.items[0]?.lastUsedAt, null)
				assert.strictEqual(
					Str.includes(secret)(yield* tokensResponse.text),
					false,
				)
				assert.deepStrictEqual(
					(yield* json(TokenList, account(bob.session, "/v1/user/tokens")))
						.items,
					[],
				)

				// A token made without a policy cannot manage tokens.
				const denied = yield* keyed(secret, "/v1/user/tokens", "POST", {
					name: "Minted",
				})
				assert.strictEqual(denied.status, 403)
				assert.strictEqual(yield* tagOf(denied), "Forbidden")
				assert.strictEqual(
					(yield* keyed(secret, "/v1/user/tokens")).status,
					403,
				)

				const foreignOrigin = yield* Caller.withCookie({
					address,
					publicOrigin: "https://attacker.example",
				})(alice.session, "/v1/user/tokens", "POST", { name: "Cross-site" })
				assert.strictEqual(foreignOrigin.status, 403)
				assert.strictEqual(
					(yield* account(alice.session, "/v1/user/tokens", "POST", {
						name: " ",
					})).status,
					400,
				)
				// A token policy that names another organization gives nothing, because
				// every check also needs the policy of the member in its own organization.
				const foreignPolicy = yield* account(
					alice.session,
					"/v1/user/tokens",
					"POST",
					{
						name: "Other organization",
						policy: yield* Policies.json(function* (_) {
							yield* _.allow("read", Authorization.Chat, {
								when: ($) => $.under("org", "someone-else"),
							})
						}),
					},
				)
				assert.strictEqual(foreignPolicy.status, 201)
				const foreign = yield* Caller.json(UserTokensApi.CreatedToken)(
					foreignPolicy,
				)
				assert.strictEqual(
					(yield* keyed(foreign.secret, "/v1/chats")).status,
					403,
				)
				assert.strictEqual(
					(yield* account(
						alice.session,
						"/v1/user/tokens/" + encodeURIComponent(foreign.token.id),
						"DELETE",
					)).status,
					204,
				)

				assert.strictEqual(
					(yield* account(
						bob.session,
						"/v1/user/tokens/" + encodeURIComponent(token.id),
						"DELETE",
					)).status,
					404,
				)
				assert.strictEqual(
					(yield* account(
						alice.session,
						"/v1/user/tokens/" + encodeURIComponent(token.id),
						"DELETE",
					)).status,
					204,
				)
				assert.strictEqual((yield* keyed(secret, "/v1/chats")).status, 401)
				assert.strictEqual(
					(yield* keyed("obut_unknown", "/v1/chats")).status,
					401,
				)

				const expiring = yield* json(
					UserTokensApi.CreatedToken,
					account(alice.session, "/v1/user/tokens", "POST", {
						name: "Short-lived",
						expiresInDays: 1,
					}),
				)
				assert.notStrictEqual(expiring.token.expiresAt, null)
				assert.strictEqual(
					(yield* keyed(expiring.secret, "/v1/chats")).status,
					200,
				)
				if (expiring.token.expiresAt === null)
					return assert.fail("The token has no expiry time.")
				assert.strictEqual(
					DateTime.toEpochMillis(
						DateTime.makeUnsafe(expiring.token.expiresAt),
					) -
						DateTime.toEpochMillis(
							DateTime.makeUnsafe(expiring.token.createdAt),
						),
					86400000,
				)
				// The server checks the expiry time in the database on each call, so
				// the test moves that time into the past.
				const now = yield* Clock.currentTimeMillis
				yield* host.run(
					Effect.gen(function* () {
						const sql = yield* PgClient.PgClient
						yield* sql`update openbot_tokens set expires_at = ${now - 1} where id = ${expiring.token.id}`
					}),
				)
				assert.strictEqual(
					(yield* keyed(expiring.secret, "/v1/chats")).status,
					401,
				)

				for (const index of Arr.range(1, 24))
					assert.strictEqual(
						(yield* account(alice.session, "/v1/user/tokens", "POST", {
							name: "Token " + index,
						})).status,
						201,
					)
				const limited = yield* account(
					alice.session,
					"/v1/user/tokens",
					"POST",
					{ name: "One too many" },
				)
				assert.strictEqual(limited.status, 409)
				assert.deepStrictEqual(yield* limited.json, {
					_tag: "TokenLimitReached",
					limit: 25,
				})
			}),
		60000,
	)

	it.effect(
		"Token policies can only narrow what the member can do",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({ publicOrigin })
				const alice = yield* host.login("alice")
				const address = yield* host.address
				const account = Caller.withCookie({ address, publicOrigin })
				const keyed = Caller.withToken(address)
				const make = Effect.fn("Tokens.make")(function* (policy: unknown) {
					const response = yield* account(
						alice.session,
						"/v1/user/tokens",
						"POST",
						{ name: "Scoped", policy },
					)
					assert.strictEqual(response.status, 201, yield* response.text)
					return (yield* Caller.json(UserTokensApi.CreatedToken)(response))
						.secret
				})

				const bot = yield* host.defaultBot(alice.session)
				const receipt = yield* message(
					(path, method, payload) =>
						account(alice.session, path, method, payload),
					bot,
					"Hello",
				)
				const chatPath = "/v1/chats/" + encodeURIComponent(receipt.chat)
				const messages = "/v1/bots/" + encodeURIComponent(bot) + "/messages"

				const readOnly = yield* make(
					yield* Policies.json(function* (_) {
						yield* _.allow("read", Authorization.Chat, Policies.own)
					}),
				)
				assert.strictEqual((yield* keyed(readOnly, "/v1/chats")).status, 200)
				const read = yield* keyed(readOnly, chatPath)
				assert.strictEqual(read.status, 200, yield* read.text)
				const { chat } = yield* Caller.json(ChatView)(read)
				const write = yield* keyed(readOnly, chatPath, "PATCH", {
					expected: chat.revision,
					mode: "plan",
				})
				assert.strictEqual(write.status, 403)
				assert.deepInclude(yield* write.json, {
					action: "write",
					kind: "Chat",
				})
				assert.strictEqual(
					(yield* keyed(readOnly, messages, "POST", {
						input: "Not allowed",
					})).status,
					403,
				)

				// A deny wins over an allow in the same token.
				const allowChats = function* (_: Policies.Builder) {
					yield* _.allow(
						["run", "read", "write"],
						Authorization.Chat,
						Policies.inOrganization,
					)
					yield* _.allow(
						["read", "delegate"],
						Authorization.Bot,
						Policies.inOrganization,
					)
				}
				const full = yield* make(yield* Policies.json(allowChats))
				const sent = yield* keyed(full, messages, "POST", { input: "Allowed" })
				assert.strictEqual(sent.status, 202, yield* sent.text)
				const denied = yield* make(
					yield* Policies.json(function* (_) {
						yield* allowChats(_)
						yield* _.deny("write", Authorization.Chat, Policies.own)
					}),
				)
				assert.strictEqual((yield* keyed(denied, "/v1/chats")).status, 200)
				const refused = yield* keyed(denied, messages, "POST", { input: "No" })
				assert.strictEqual(refused.status, 403)
				assert.deepInclude(yield* refused.json, {
					action: "write",
					kind: "Chat",
				})

				// A token never gets more than its member. Alice is a Super Administrator,
				// but she loses organization.write here, and so does her broad token.
				const broad = yield* make(
					yield* Policies.json(function* (_) {
						yield* _.allow(
							["read", "write"],
							Authorization.Organization,
							Policies.inOrganization,
						)
					}),
				)
				assert.strictEqual(
					(yield* keyed(broad, "/v1/organization", "PATCH", { name: "Acme" }))
						.status,
					200,
				)
				const bob = yield* host.login("bob")
				const promoted = yield* account(
					alice.session,
					"/v1/organization/members/" + encodeURIComponent(bob.identity.userId),
					"PATCH",
					{ roles: ["super_administrator"] },
				)
				assert.strictEqual(promoted.status, 200, yield* promoted.text)
				const narrowed = yield* account(
					bob.session,
					"/v1/organization/members/" +
						encodeURIComponent(alice.identity.userId),
					"PATCH",
					{ roles: ["member"] },
				)
				assert.strictEqual(narrowed.status, 200, yield* narrowed.text)
				assert.strictEqual(
					(yield* keyed(broad, "/v1/organization", "PATCH", {
						name: "Acme 2",
					})).status,
					403,
				)
			}),
		60000,
	)
})
