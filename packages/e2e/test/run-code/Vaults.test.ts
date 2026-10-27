import { PgClient } from "@effect/sql-pg"
import { assert, it } from "@effect/vitest"
import {
	ConnectionsApi,
	FailureApi,
	RequestsApi,
	VaultsApi,
} from "@openbot-build/api"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import {
	Array as Arr,
	Effect,
	Layer,
	Option,
	pipe,
	Ref,
	Schedule,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, type Prompt, Response } from "effect/ai"
import type { HttpClientResponse, HttpMethod } from "effect/http"
import { AppHost } from "@openbot-build/openbot"
import {
	Apps,
	AppFixture as Fixture,
	BrowserHost,
	Caller,
	Messages,
} from "@openbot-build/openbot/testing"
const { message, settled } = Messages
type Send = Messages.Send

const secret = "ghp_vault-test-secret-42"
const remoteSecret = "pw-from-1password"

/** The Chat did not give the answer that the test waits for. */
class NoAnswer extends Schema.TaggedError<
	NoAnswer,
	{ readonly brand: unique symbol }
>()("NoAnswer", { pattern: Schema.String }) {
	override get message() {
		return "The Chat did not answer with " + this.pattern
	}
}

/**
 * A connection draft, with only the fields that the test reads. The server
 * writes absent requirement fields as null, which the full draft schema does
 * not take.
 */
const Draft = Schema.Struct({ id: Schema.String, revision: Schema.Int })

/** Gives a value as JSON text. */
const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const readers = Apps.passwordReaderLayer({ password: remoteSecret })

const usage = {
	inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}
const answer = (text: string): Stream.Stream<Response.StreamPartEncoded> =>
	Stream.make(
		Response.makePart("text-start", { id: "answer" }),
		Response.makePart("text-delta", { id: "answer", delta: text }),
		Response.makePart("text-end", { id: "answer" }),
		Response.makePart("finish", { reason: "stop", usage }),
	)

const isUser = (message: Prompt.Message): message is Prompt.UserMessage =>
	message.role === "user"

/** The text parts of a message of the person, as one text. */
const textOf = (message: Prompt.UserMessage) =>
	pipe(
		message.content,
		Arr.filter((part) => part.type === "text"),
		Arr.map((part) => part.text),
		Arr.join(""),
	)

/** The model runs each message as a program, and answers with the result of the program. */
const programs = (seen: Ref.Ref<ReadonlyArray<string>>) =>
	LanguageModel.make({
		generateText: () =>
			Effect.succeed([Response.makePart("text", { text: '{"changes":[]}' })]),
		streamText: ({ prompt, tools }) =>
			Stream.unwrap(
				Effect.gen(function* () {
					// The model sees all of this text. A secret must never be in it.
					const content = yield* Effect.orDie(jsonText(prompt.content))
					const toolText = yield* Effect.orDie(jsonText(tools))
					yield* Ref.update(seen, Arr.appendAll([content, toolText]))
					const found = Arr.findLastIndex(prompt.content, isUser)
					const last = Option.getOrElse(found, () => -1)
					const input = pipe(
						found,
						Option.flatMap((index) => Arr.get(prompt.content, index)),
						Option.filter(isUser),
						Option.map(textOf),
						Option.getOrElse(() => ""),
					)
					if (Str.startsWith("[OpenBot]")(input)) return answer(input)
					const result = pipe(
						Arr.drop(prompt.content, last + 1),
						Arr.flatMap((entry) =>
							entry.role === "tool"
								? Arr.filter(
										entry.content,
										(part) => part.type === "tool-result",
									)
								: [],
						),
						Arr.last,
					)
					if (Option.isSome(result))
						return answer(yield* Effect.orDie(jsonText(result.value.result)))
					return Stream.make(
						Response.makePart("tool-call", {
							id: "code-call-" + last,
							name: "openbot_run_code",
							params: { code: input, reason: "The test needs it." },
							providerExecuted: false,
						}),
						Response.makePart("finish", { reason: "tool-calls", usage }),
					)
				}),
			),
	})

// The host runs real servers, so the test needs real time.
it.layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"Vaults keep their secrets, and Code Mode sends them only to the tools that an item allows",
		() =>
			Effect.gen(function* () {
				const publisher = yield* Fixture.start({ capabilities: true })
				const seen = yield* Ref.make<ReadonlyArray<string>>([])
				const publicOrigin = "https://openbot.fixture.test"
				const host = yield* BrowserHost.start({
					publicOrigin,
					model: yield* programs(seen),
					// Reading documents of the work connection needs no decision.
					appReadRules: [
						{ cardUrl: publisher.origin + "/card", tool: "read_document" },
					],
					codeMode: {
						enabled: true,
						timeoutMs: 5_000,
						memoryMb: 32,
						outputBytes: 64 * 1024,
					},
					discovery: publisher.discovery,
					appProbe: publisher.probe,
					appNetwork: Layer.succeed(AppHost.AppNetwork, {
						layer: (owner, origins) =>
							NodeHttpServer.layerUserNetwork({
								owner,
								allowedOrigins: origins,
								ca: publisher.ca,
								allowAddress: (ip) => ip === "127.0.0.1",
							}),
					}),
					vaultReaders: readers,
				})
				const alice = yield* host.login("vault-alice")
				const bob = yield* host.login("vault-bob")
				const bot = yield* host.defaultBot(alice.session)
				yield* host.defaultBot(bob.session)
				const withCookie = Caller.withCookie({
					address: yield* host.address,
					publicOrigin,
				})
				const call = (
					method: HttpMethod.HttpMethod,
					path: string,
					body?: unknown,
					session = alice.session,
				) => withCookie(session, path, method, body)
				const asAlice: Send = (path, method, payload) =>
					call(method, path, payload)
				/** Every answer of the API is checked: no secret ever comes out. */
				const text = Effect.fn("Vaults.text")(function* (
					response: HttpClientResponse.HttpClientResponse,
					status: number,
				) {
					const body = yield* response.text
					assert.strictEqual(response.status, status, body)
					assert.strictEqual(Str.includes(secret)(body), false, body)
					assert.strictEqual(Str.includes(remoteSecret)(body), false, body)
					return body
				})
				/** Checks an answer like `text`, and reads its JSON with a schema. */
				const read = <S extends Schema.Constraint>(
					response: HttpClientResponse.HttpClientResponse,
					status: number,
					schema: S,
				) =>
					Effect.flatMap(
						text(response, status),
						Schema.decodeEffect(Schema.fromJsonString(schema)),
					)

				for (const [path, connectionName, account] of [
					["/card", "Work documents", "Work"],
					["/second", "Personal documents", "Personal"],
				] as const) {
					const draft = yield* read(
						yield* call("POST", "/v1/connection-drafts", {
							input: publisher.origin + path,
						}),
						201,
						Draft,
					)
					yield* text(
						yield* call("POST", "/v1/connections", {
							draftId: draft.id,
							revision: draft.revision,
							cardUrl: publisher.origin + path,
							remoteIndex: 0,
							values: {
								"header:X-Account": account,
								"header:X-Secret": "private-" + account,
							},
							name: connectionName,
							confirmed: true,
						}),
						201,
					)
				}
				const connections = yield* read(
					yield* call("GET", "/v1/connections"),
					200,
					Schema.Array(ConnectionsApi.Connection),
				)
				const connectionId = (name: string) => {
					const found = Arr.findFirst(
						connections,
						(connection) => connection.name === name,
					)
					assert.ok(Option.isSome(found), name)
					return found.value.id
				}

				// A secret provider must take the token. Its token never comes out.
				yield* text(
					yield* call("POST", "/v1/secret-providers", {
						name: "Bad",
						credentials: {
							kind: "onepassword",
							url: "https://connect.example.com",
							token: "bad",
						},
					}),
					400,
				)
				const offline = yield* call("POST", "/v1/secret-providers", {
					name: "Offline",
					credentials: {
						kind: "onepassword",
						url: "https://connect.example.com",
						token: "offline",
					},
				})
				const offlineError = yield* read(
					offline,
					503,
					FailureApi.RequestFailed,
				)
				assert.strictEqual(offlineError._tag, "RequestFailed")
				assert.strictEqual(offlineError.category, "unavailable")
				assert.isAbove(offlineError.errorId.length, 0)
				assert.strictEqual(
					offline.headers["openbot-error-id"],
					offlineError.errorId,
				)

				const provider = yield* read(
					yield* call("POST", "/v1/secret-providers", {
						name: "1Password",
						credentials: {
							kind: "onepassword",
							url: "https://connect.example.com",
							token: "op-token-1234",
						},
					}),
					201,
					VaultsApi.SecretProvider,
				)
				assert.deepStrictEqual(provider.credentials, {
					kind: "onepassword",
					url: "https://connect.example.com",
					token: { set: true, hint: "…1234" },
				})

				// One Vault collects secrets from many places: OpenBot itself and a provider.
				const vault = yield* read(
					yield* call("POST", "/v1/vaults", { name: "Team secrets" }),
					201,
					VaultsApi.Vault,
				)
				const item = yield* read(
					yield* call("POST", `/v1/vaults/${vault.id}/items`, {
						name: "github",
						description: "The GitHub token of the team.",
						source: { _tag: "Builtin" },
						values: { token: secret },
						exits: [
							{
								_tag: "App",
								connection: connectionId("Work documents"),
								tool: "read_document",
							},
							{
								_tag: "App",
								connection: connectionId("Personal documents"),
								tool: "write_board",
							},
						],
					}),
					201,
					VaultsApi.VaultItem,
				)
				assert.deepStrictEqual(item.fields, ["token"])
				yield* text(
					yield* call("POST", `/v1/vaults/${vault.id}/items`, {
						name: "github",
						source: { _tag: "Builtin" },
						values: { token: "other" },
						exits: [],
					}),
					400,
				)
				const fromProvider = (fields: ReadonlyArray<string>) => ({
					name: "mail",
					source: {
						_tag: "OnePassword",
						provider: provider.id,
						vault: "v1",
						item: "i1",
					},
					fields,
					exits: [
						{
							_tag: "App",
							connection: connectionId("Personal documents"),
							tool: null,
						},
					],
				})
				// The provider must have the fields, and must be of the kind of the source.
				yield* text(
					yield* call(
						"POST",
						`/v1/vaults/${vault.id}/items`,
						fromProvider(["password", "totp"]),
					),
					400,
				)
				yield* text(
					yield* call("POST", `/v1/vaults/${vault.id}/items`, {
						...fromProvider(["password"]),
						source: { _tag: "Bitwarden", provider: provider.id, item: "i1" },
					}),
					400,
				)
				const mail = yield* read(
					yield* call(
						"POST",
						`/v1/vaults/${vault.id}/items`,
						fromProvider(["password"]),
					),
					201,
					VaultsApi.VaultItem,
				)
				assert.ok(mail.source._tag === "OnePassword")
				assert.strictEqual(mail.source.provider, provider.id)
				// A provider cannot go while an item reads from it.
				yield* text(
					yield* call("DELETE", `/v1/secret-providers/${provider.id}`),
					409,
				)
				yield* text(
					yield* call("PUT", `/v1/vaults/${vault.id}/bots/${bot}`),
					200,
				)
				yield* text(
					yield* call("GET", `/v1/vaults/${vault.id}/items/${item.id}`),
					200,
				)
				yield* text(yield* call("GET", `/v1/vaults/${vault.id}/bots`), 200)
				// Other members do not learn that the Vault or the provider exists,
				// and cannot read secrets from the provider of another member.
				yield* text(
					yield* call("GET", `/v1/vaults/${vault.id}`, undefined, bob.session),
					404,
				)
				assert.strictEqual(
					(yield* read(
						yield* call("GET", "/v1/vaults", undefined, bob.session),
						200,
						Schema.Array(VaultsApi.Vault),
					)).length,
					0,
				)
				const bobVault = yield* read(
					yield* call("POST", "/v1/vaults", { name: "Bob" }, bob.session),
					201,
					VaultsApi.Vault,
				)
				yield* text(
					yield* call(
						"POST",
						`/v1/vaults/${bobVault.id}/items`,
						fromProvider(["password"]),
						bob.session,
					),
					404,
				)

				/** The Chat of the programs. The first program starts it. */
				const chat = yield* Ref.make("")
				const run = Effect.fn("Vaults.run")(function* (code: string) {
					const receipt = yield* message(asAlice, bot, code)
					const current = yield* Ref.updateAndGet(chat, (id) =>
						id === "" ? receipt.chat : id,
					)
					return yield* settled(asAlice, current)
				})
				/** Waits for the requests of the Chat that wait for a decision. */
				const pending = Effect.flatMap(Ref.get(chat), (id) =>
					Effect.flatMap(
						call("GET", "/v1/requests?status=pending"),
						Caller.json(Schema.Array(RequestsApi.CapabilityRequest)),
					).pipe(Effect.map(Arr.filter((entry) => entry.chat === id))),
				).pipe(
					Effect.repeat({
						until: Arr.isReadonlyArrayNonEmpty,
						schedule: Schedule.spaced("25 millis"),
						times: 199,
					}),
				)
				const allow = Effect.gen(function* () {
					const [request] = yield* pending
					assert.ok(request, "A call of the program waits for a decision.")
					// The decider sees the reference, not the secret.
					assert.strictEqual(
						Str.includes(secret)(yield* jsonText(request)),
						false,
					)
					assert.match(
						yield* jsonText(request.app?.arguments),
						/⟦vault:(github\/token|mail\/password)⟧/,
					)
					yield* text(
						yield* call("POST", "/v1/requests/" + request.id, {
							commandKey: `answer-14431:${request.id}`,
							expected: request.revision,
							decision: "allow",
						}),
						202,
					)
				})
				/** Waits until the Chat is at rest and its last answer has this text. */
				const answered = (pattern: RegExp) =>
					Effect.flatMap(Ref.get(chat), (id) => settled(asAlice, id)).pipe(
						Effect.flatMap((view) =>
							Effect.map(jsonText(view.response), (response) =>
								pattern.test(response) ? Option.some(view) : Option.none(),
							),
						),
						Effect.repeat({
							until: Option.isSome,
							schedule: Schedule.spaced("25 millis"),
							times: 199,
						}),
						Effect.flatMap(
							Option.match({
								onNone: () =>
									Effect.fail(NoAnswer.make({ pattern: String(pattern) })),
								onSome: Effect.succeed,
							}),
						),
					)

				// A program sees references, and a tool that the item does not allow gets nothing.
				const first = yield* run(`
				let denied = ""
				try {
					await apps.personal_documents.read_document({ id: vault.github.token })
				} catch (error) {
					denied = error.name + ": " + error.message
				}
				return { ref: vault.github.token, items: Object.keys(vault), denied }
			`)
				const firstText = yield* jsonText(first.response)
				assert.match(firstText, /⟦vault:github\/token⟧/, firstText)
				assert.match(firstText, /VaultDenied/)
				assert.match(firstText, /github.*mail|mail.*github/)
				assert.strictEqual(yield* publisher.businessCalls, 0)
				// The Code Mode tools name the items, and never a value.
				assert.ok(Arr.some(yield* Ref.get(seen), Str.includes("vault.github")))

				// A tool that only reads needs a decision when it gets a secret. Its result comes back without it.
				yield* run(
					`return await apps.work_documents.read_document({ id: vault.github.token })`,
				)
				assert.strictEqual(yield* publisher.businessCalls, 0)
				yield* allow
				yield* answered(/⟦hidden:github\/token⟧/)
				assert.strictEqual(yield* publisher.businessCalls, 1)

				// The App gets the secret in place of the reference.
				yield* run(`
				await apps.personal_documents.write_board({ id: "note", text: "Bearer " + vault.github.token })
				await apps.personal_documents.write_board({ id: "mail", text: vault.mail.password })
				return "written"
			`)
				yield* allow
				yield* allow
				yield* answered(/written/)
				assert.deepStrictEqual(yield* publisher.writes, [
					{ account: "Personal", text: "Bearer " + secret },
					{ account: "Personal", text: remoteSecret },
				])

				// Nothing that people or the model can read has the secret: not the Chat,
				// not the programs, not the App operations, not what the model saw.
				const chatId = yield* Ref.get(chat)
				yield* text(yield* call("GET", "/v1/chats/" + chatId), 200)
				yield* text(
					yield* call("GET", "/v1/chats/" + chatId + "/code-runs"),
					200,
				)
				yield* text(
					yield* call("GET", "/v1/chats/" + chatId + "/app-operations"),
					200,
				)
				for (const entry of yield* Ref.get(seen)) {
					assert.strictEqual(Str.includes(secret)(entry), false)
					assert.strictEqual(Str.includes(remoteSecret)(entry), false)
				}
				// The values are sealed in the database.
				yield* host.run(
					Effect.gen(function* () {
						const sql = yield* PgClient.PgClient
						const rows = yield* sql<{
							readonly values: string | null
						}>`select "values" from openbot_vault_items`
						assert.strictEqual(rows.length, 2)
						for (const row of rows)
							assert.strictEqual(
								row.values !== null && Str.includes(secret)(row.values),
								false,
							)
						const sealed = yield* sql<{
							readonly credentials: string
						}>`select credentials from openbot_secret_providers`
						for (const row of sealed)
							assert.strictEqual(
								Str.includes("op-token-1234")(row.credentials),
								false,
							)
					}),
				)

				// Without the right, the program has no items.
				yield* text(
					yield* call("DELETE", `/v1/vaults/${vault.id}/bots/${bot}`),
					204,
				)
				const after = yield* run(`return { items: Object.keys(vault).length }`)
				assert.match(yield* jsonText(after.response), /items.{0,6}0/)
				yield* text(yield* call("DELETE", `/v1/vaults/${vault.id}`), 204)
				yield* text(yield* call("GET", `/v1/vaults/${vault.id}`), 404)
				// Without items, the provider can go.
				yield* text(
					yield* call("DELETE", `/v1/secret-providers/${provider.id}`),
					204,
				)
			}),
		// This test runs four programs and three approvals over real HTTP.
		{ timeout: 60_000 },
	)
})
