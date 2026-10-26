import { assert, it } from "@effect/vitest"
import { VaultsApi } from "@openbot-build/api"
import { Array as Arr, Effect, Record as Rec, Ref, String as Str } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Readers from "../src/vaults/Readers.ts"

const provider = VaultsApi.SecretProviderId.make("spr_test")

interface Seen {
	readonly url: string
	readonly headers: Readonly<Record<string, string>>
}

/** A fake password manager: one function answers every request, and the test keeps a log. */
const fake = (answer: (seen: Seen) => Effect.Effect<Response>) =>
	Effect.gen(function* () {
		const log = yield* Ref.make<ReadonlyArray<Seen>>([])
		const client = HttpClient.make((request, url) => {
			const seen: Seen = { url: url.toString(), headers: request.headers }
			return Ref.update(log, Arr.append(seen)).pipe(
				Effect.andThen(answer(seen)),
				Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
			)
		})
		return { log: Ref.get(log), client }
	})

const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	})

it.effect("1Password Connect finds fields by label, ID and purpose", () =>
	Effect.gen(function* () {
		const { log, client } = yield* fake((seen) =>
			Effect.succeed(
				Str.endsWith("/v1/vaults")(seen.url)
					? json([])
					: json({
							fields: [
								{ id: "username", purpose: "USERNAME", value: "alice" },
								{ id: "x1", purpose: "PASSWORD", label: "secret", value: "pw" },
								{ id: "x2", label: "API key", value: "key-1" },
							],
						}),
			),
		)
		const reader = Readers.onePassword(client, {
			kind: "onepassword",
			url: "https://connect.example.com",
			token: "op-token",
		})
		yield* reader.verify
		const values = yield* reader.read(
			{ _tag: "OnePassword", provider, vault: "v 1", item: "i1" },
			["username", "password", "API key"],
		)
		assert.deepStrictEqual(
			[...values],
			[
				["username", "alice"],
				["password", "pw"],
				["API key", "key-1"],
			],
		)
		const seen = yield* log
		assert.strictEqual(
			seen[1]?.url,
			"https://connect.example.com/v1/vaults/v%201/items/i1",
		)
		assert.strictEqual(seen[1]?.headers["authorization"], "Bearer op-token")
		const missing = yield* Effect.flip(
			reader.read({ _tag: "OnePassword", provider, vault: "v", item: "i" }, [
				"totp",
			]),
		)
		assert.match(missing.message, /no field with the name totp/)
		const wrong = yield* Effect.flip(
			reader.read({ _tag: "HashiCorp", provider, path: "a" }, ["x"]),
		)
		assert.match(wrong.message, /not for a 1Password Vault/)
	}),
)

it.effect(
	"Bitwarden reads `bw serve`, gives the current code, and needs an unlocked vault",
	() =>
		Effect.gen(function* () {
			const status = yield* Ref.make("unlocked")
			const { log, client } = yield* fake((seen) => {
				if (Str.endsWith("/status")(seen.url))
					return Effect.map(Ref.get(status), (status) =>
						json({ success: true, data: { template: { status } } }),
					)
				if (Str.includes("/object/totp/")(seen.url))
					return Effect.succeed(
						json({
							success: true,
							data: { object: "string", data: "123456" },
						}),
					)
				return Effect.succeed(
					json({
						success: true,
						data: {
							login: { username: "bob", password: "hunter2" },
							notes: null,
							fields: [{ name: "pin", value: "0000" }],
						},
					}),
				)
			})
			const reader = Readers.bitwarden(client, {
				kind: "bitwarden",
				url: "http://localhost:8087",
			})
			yield* reader.verify
			const values = yield* reader.read(
				{ _tag: "Bitwarden", provider, item: "abc" },
				["password", "pin", "totp"],
			)
			assert.deepStrictEqual(Rec.fromEntries(values), {
				password: "hunter2",
				pin: "0000",
				totp: "123456",
			})
			const seen = yield* log
			assert.strictEqual(seen[1]?.url, "http://localhost:8087/object/item/abc")
			assert.strictEqual(seen[1]?.headers["authorization"], undefined)
			yield* Ref.set(status, "locked")
			const locked = yield* Effect.flip(reader.verify)
			assert.match(locked.message, /locked/)
		}),
)

it.effect(
	"HashiCorp Vault reads the KV version 2 engine with the token and namespace",
	() =>
		Effect.gen(function* () {
			const { log, client } = yield* fake((seen) =>
				Effect.succeed(
					Str.endsWith("/lookup-self")(seen.url)
						? json({ data: {} })
						: Str.includes("/gone")(seen.url)
							? json({ errors: [] }, 404)
							: json({ data: { data: { token: "s.1", port: 5432 } } }),
				),
			)
			const reader = Readers.hashiCorp(client, {
				kind: "hashicorp",
				url: "https://vault.example.com",
				token: "hvs.test",
				mount: "kv/",
				namespace: "team",
			})
			yield* reader.verify
			const values = yield* reader.read(
				{ _tag: "HashiCorp", provider, path: "/bots/db/" },
				["token", "port"],
			)
			assert.deepStrictEqual(Rec.fromEntries(values), {
				token: "s.1",
				port: "5432",
			})
			const seen = yield* log
			assert.strictEqual(
				seen[1]?.url,
				"https://vault.example.com/v1/kv/data/bots/db",
			)
			assert.strictEqual(seen[1]?.headers["x-vault-token"], "hvs.test")
			assert.strictEqual(seen[1]?.headers["x-vault-namespace"], "team")
			const gone = yield* Effect.flip(
				reader.read({ _tag: "HashiCorp", provider, path: "gone" }, ["token"]),
			)
			assert.match(gone.message, /no such item/)
		}),
)
