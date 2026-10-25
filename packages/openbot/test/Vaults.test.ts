// @effect-diagnostics strictEffectProvide:off
import { PgClient } from "@effect/sql-pg"
import { assert, it } from "@effect/vitest"
import { AuthApi, RequestsApi, VaultsApi } from "@openbot-build/api"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { Effect, Layer, Match, Redacted, Schema, Stream } from "effect"
import { LanguageModel, Response } from "effect/ai"
import { AppNetwork } from "../src/apps/AppHost.ts"
import { Readers, VaultReadFailed } from "../src/vaults/Readers.ts"
import * as Fixture from "./AppFixture.ts"
import * as BrowserHost from "./BrowserHost.ts"
import { message, settled, type Send } from "./Messages.ts"

const secret = "ghp_vault-test-secret-42"
const remoteSecret = "pw-from-1password"

/** A password manager in memory. A token called `bad` does not work. */
const readers = Layer.succeed(
	Readers,
	Readers.of({
		make: (credentials) => ({
			verify:
				credentials.kind !== "bitwarden" && credentials.token === "bad"
					? Effect.fail(new VaultReadFailed({ message: "Wrong token" }))
					: Effect.void,
			read: (_source, fields) =>
				fields.every((field) => field === "password")
					? Effect.succeed(
							new Map(fields.map((field) => [field, remoteSecret])),
						)
					: Effect.fail(new VaultReadFailed({ message: "No such field" })),
		}),
	}),
)

const usage = {
	inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}
const answer = (text: string) =>
	Stream.make(
		Response.makePart("text-start", { id: "answer" }),
		Response.makePart("text-delta", { id: "answer", delta: text }),
		Response.makePart("text-end", { id: "answer" }),
		Response.makePart("finish", { reason: "stop", usage }),
	)

/** The model runs each message as a program, and answers with the result of the program. */
const programs = (seen: Array<string>) =>
	Effect.runPromise(
		LanguageModel.make({
			generateText: () =>
				Effect.succeed([Response.makePart("text", { text: '{"changes":[]}' })]),
			streamText: ({ prompt, tools }) =>
				Stream.suspend((): Stream.Stream<Response.StreamPartEncoded> => {
					// The model sees all of this text. A secret must never be in it.
					seen.push(JSON.stringify(prompt.content), JSON.stringify(tools))
					const last = prompt.content.findLastIndex(
						(entry) => entry.role === "user",
					)
					const input = Match.value(prompt.content[last]).pipe(
						Match.when({ role: "user" }, (entry) =>
							entry.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join(""),
						),
						Match.orElse(() => ""),
					)
					if (input.startsWith("[OpenBot]")) return answer(input)
					const result = prompt.content
						.slice(last + 1)
						.flatMap((entry) =>
							Match.value(entry).pipe(
								Match.when({ role: "tool" }, (entry) =>
									entry.content.filter((part) => part.type === "tool-result"),
								),
								Match.orElse(() => []),
							),
						)
						.at(-1)
					if (result !== undefined) return answer(JSON.stringify(result.result))
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
		}),
	)

it("Vaults keep their secrets, and Code Mode sends them only to the tools that an item allows", async () => {
	const publisher = await Fixture.start({ capabilities: true })
	const seen: Array<string> = []
	const publicOrigin = "https://openbot.fixture.test"
	const host = await BrowserHost.start({
		publicOrigin,
		model: await programs(seen),
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
		appNetwork: Layer.succeed(AppNetwork, {
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
	try {
		const alice = await host.login("vault-alice")
		const bob = await host.login("vault-bob")
		const bot = await host.defaultBot(alice.session)
		await host.defaultBot(bob.session)
		const headers = (session = alice.session) => ({
			cookie:
				AuthApi.SessionCookie +
				"=" +
				encodeURIComponent(Redacted.value(session)),
			origin: publicOrigin,
			"content-type": "application/json",
		})
		const call = (
			method: string,
			path: string,
			body?: unknown,
			session = alice.session,
		) =>
			fetch(host.address + path, {
				method,
				headers: headers(session),
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			})
		const asAlice: Send = (path, method, payload) => call(method, path, payload)
		/** Every answer of the API is checked: no secret ever comes out. */
		const text = async (response: globalThis.Response, status: number) => {
			const body = await response.text()
			assert.strictEqual(response.status, status, body)
			assert.strictEqual(body.includes(secret), false, body)
			assert.strictEqual(body.includes(remoteSecret), false, body)
			return body
		}

		for (const [path, connectionName, account] of [
			["/card", "Work documents", "Work"],
			["/second", "Personal documents", "Personal"],
		] as const) {
			const draft = await (
				await call("POST", "/v1/connection-drafts", {
					input: publisher.origin + path,
				})
			).json()
			await text(
				await call("POST", "/v1/connections", {
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
		const connections = (await (
			await call("GET", "/v1/connections")
		).json()) as ReadonlyArray<{ readonly id: string; readonly name: string }>
		const connectionId = (name: string) =>
			connections.find((connection) => connection.name === name)!.id

		// A secret provider must take the token. Its token never comes out.
		await text(
			await call("POST", "/v1/secret-providers", {
				name: "Bad",
				credentials: {
					kind: "onepassword",
					url: "https://connect.example.com",
					token: "bad",
				},
			}),
			400,
		)
		const provider = Schema.decodeUnknownSync(VaultsApi.SecretProvider)(
			JSON.parse(
				await text(
					await call("POST", "/v1/secret-providers", {
						name: "1Password",
						credentials: {
							kind: "onepassword",
							url: "https://connect.example.com",
							token: "op-token-1234",
						},
					}),
					201,
				),
			),
		)
		assert.deepStrictEqual(provider.credentials, {
			kind: "onepassword",
			url: "https://connect.example.com",
			token: { set: true, hint: "…1234" },
		})

		// One Vault collects secrets from many places: OpenBot itself and a provider.
		const vault = Schema.decodeUnknownSync(VaultsApi.Vault)(
			JSON.parse(
				await text(
					await call("POST", "/v1/vaults", { name: "Team secrets" }),
					201,
				),
			),
		)
		const item = Schema.decodeUnknownSync(VaultsApi.VaultItem)(
			JSON.parse(
				await text(
					await call("POST", `/v1/vaults/${vault.id}/items`, {
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
				),
			),
		)
		assert.deepStrictEqual(item.fields, ["token"])
		await text(
			await call("POST", `/v1/vaults/${vault.id}/items`, {
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
		await text(
			await call(
				"POST",
				`/v1/vaults/${vault.id}/items`,
				fromProvider(["password", "totp"]),
			),
			400,
		)
		await text(
			await call("POST", `/v1/vaults/${vault.id}/items`, {
				...fromProvider(["password"]),
				source: { _tag: "Bitwarden", provider: provider.id, item: "i1" },
			}),
			400,
		)
		const mail = JSON.parse(
			await text(
				await call(
					"POST",
					`/v1/vaults/${vault.id}/items`,
					fromProvider(["password"]),
				),
				201,
			),
		)
		assert.strictEqual(mail.source.provider, provider.id)
		// A provider cannot go while an item reads from it.
		await text(await call("DELETE", `/v1/secret-providers/${provider.id}`), 400)
		await text(await call("PUT", `/v1/vaults/${vault.id}/bots/${bot}`), 200)
		await text(
			await call("GET", `/v1/vaults/${vault.id}/items/${item.id}`),
			200,
		)
		await text(await call("GET", `/v1/vaults/${vault.id}/bots`), 200)
		// Other members do not learn that the Vault or the provider exists,
		// and cannot read secrets from the provider of another member.
		await text(
			await call("GET", `/v1/vaults/${vault.id}`, undefined, bob.session),
			404,
		)
		assert.strictEqual(
			JSON.parse(
				await text(
					await call("GET", "/v1/vaults", undefined, bob.session),
					200,
				),
			).length,
			0,
		)
		const bobVault = JSON.parse(
			await text(
				await call("POST", "/v1/vaults", { name: "Bob" }, bob.session),
				201,
			),
		)
		await text(
			await call(
				"POST",
				`/v1/vaults/${bobVault.id}/items`,
				fromProvider(["password"]),
				bob.session,
			),
			404,
		)

		let chat = ""
		const run = async (code: string) => {
			const receipt = await message(asAlice, bot, code)
			if (chat === "") chat = receipt.chat
			return settled(asAlice, chat)
		}
		const pending = async () => {
			for (let tries = 0; tries < 200; tries++) {
				const list = Schema.decodeUnknownSync(
					Schema.Array(RequestsApi.CapabilityRequest),
				)(
					await (await call("GET", "/v1/requests?status=pending")).json(),
				).filter((entry) => entry.chat === chat)
				if (list.length > 0) return list
				await new Promise((resolve) => setTimeout(resolve, 25))
			}
			return []
		}
		const allow = async () => {
			const [request] = await pending()
			assert.ok(request, "A call of the program waits for a decision.")
			// The decider sees the reference, not the secret.
			assert.strictEqual(JSON.stringify(request).includes(secret), false)
			assert.match(
				JSON.stringify(request.app?.arguments),
				/⟦vault:(github\/token|mail\/password)⟧/,
			)
			await text(
				await call("POST", "/v1/requests/" + request.id, {
					expected: request.revision,
					decision: "allow",
				}),
				200,
			)
		}
		const answered = async (pattern: RegExp) => {
			for (let tries = 0; tries < 200; tries++) {
				const view = await settled(asAlice, chat)
				if (pattern.test(JSON.stringify(view.response))) return view
				await new Promise((resolve) => setTimeout(resolve, 25))
			}
			throw new Error("The Chat did not answer with " + pattern)
		}

		// A program sees references, and a tool that the item does not allow gets nothing.
		const first = await run(`
			let denied = ""
			try {
				await apps.personal_documents.read_document({ id: vault.github.token })
			} catch (error) {
				denied = error.name + ": " + error.message
			}
			return { ref: vault.github.token, items: Object.keys(vault), denied }
		`)
		const firstText = JSON.stringify(first.response)
		assert.match(firstText, /⟦vault:github\/token⟧/)
		assert.match(firstText, /VaultDenied/)
		assert.match(firstText, /github.*mail|mail.*github/)
		assert.strictEqual(publisher.businessCalls(), 0)
		// The Code Mode tools name the items, and never a value.
		assert.ok(seen.some((entry) => entry.includes("vault.github")))

		// A tool that only reads needs a decision when it gets a secret. Its result comes back without it.
		await run(
			`return await apps.work_documents.read_document({ id: vault.github.token })`,
		)
		assert.strictEqual(publisher.businessCalls(), 0)
		await allow()
		await answered(/⟦hidden:github\/token⟧/)
		assert.strictEqual(publisher.businessCalls(), 1)

		// The App gets the secret in place of the reference.
		await run(`
			await apps.personal_documents.write_board({ id: "note", text: "Bearer " + vault.github.token })
			await apps.personal_documents.write_board({ id: "mail", text: vault.mail.password })
			return "written"
		`)
		await allow()
		await allow()
		await answered(/written/)
		assert.deepStrictEqual(publisher.writes(), [
			{ account: "Personal", text: "Bearer " + secret },
			{ account: "Personal", text: remoteSecret },
		])

		// Nothing that people or the model can read has the secret: not the Chat,
		// not the programs, not the App operations, not what the model saw.
		await text(await call("GET", "/v1/chats/" + chat), 200)
		await text(await call("GET", "/v1/chats/" + chat + "/code-runs"), 200)
		await text(await call("GET", "/v1/chats/" + chat + "/app-operations"), 200)
		for (const entry of seen) {
			assert.strictEqual(entry.includes(secret), false)
			assert.strictEqual(entry.includes(remoteSecret), false)
		}
		// The values are sealed in the database.
		await host.runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				const rows = yield* sql<{
					readonly values: string | null
				}>`select "values" from openbot_vault_items`
				assert.strictEqual(rows.length, 2)
				for (const row of rows)
					assert.strictEqual(row.values?.includes(secret) ?? false, false)
				const sealed = yield* sql<{
					readonly credentials: string
				}>`select credentials from openbot_secret_providers`
				for (const row of sealed)
					assert.strictEqual(row.credentials.includes("op-token-1234"), false)
			}),
		)

		// Without the right, the program has no items.
		await text(await call("DELETE", `/v1/vaults/${vault.id}/bots/${bot}`), 204)
		const after = await run(`return { items: Object.keys(vault).length }`)
		assert.match(JSON.stringify(after.response), /items.{0,6}0/)
		await text(await call("DELETE", `/v1/vaults/${vault.id}`), 204)
		await text(await call("GET", `/v1/vaults/${vault.id}`), 404)
		// Without items, the provider can go.
		await text(await call("DELETE", `/v1/secret-providers/${provider.id}`), 204)
	} finally {
		await host.close()
		await publisher.close()
	}
})
