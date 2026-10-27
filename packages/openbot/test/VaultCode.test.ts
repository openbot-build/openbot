import * as ErrorRecordsFixture from "./ErrorRecordsFixture.ts"
import { NodeFileSystem } from "@effect/platform-node"
import { assert, it, layer } from "@effect/vitest"
import { VaultsApi } from "@openbot-build/api"
import { Array as Arr, Effect, Layer, String as Str } from "effect"
import { make } from "../src/code/Sandbox.ts"
import * as VaultCode from "../src/vaults/CodeMode.ts"
import type { Usable } from "../src/vaults/Vaults.ts"

const secret = "ghp_s3cret-Value/42"

const usable = (
	id: string,
	name: string,
	exits: ReadonlyArray<VaultsApi.VaultExit>,
): Usable => ({
	vaultName: "Team",
	item: {
		id: VaultsApi.VaultItemId.make(id),
		vault: VaultsApi.VaultId.make("vlt_1"),
		name,
		description: "The GitHub token of the team.",
		source: { _tag: "Builtin" },
		fields: ["token"],
		exits,
		version: 0,
		createdAt: 0,
		updatedAt: 0,
	},
})

it("each Vault item gets a stable name, and references are found in all strings", () => {
	const entries = VaultCode.aliases([
		usable("vli_b", "github", []),
		usable("vli_a", "github", []),
	])
	assert.deepStrictEqual(
		Arr.map(entries, (entry) => [entry.alias, entry.usable.item.id]),
		[
			["github", "vli_a"],
			["github_2", "vli_b"],
		],
	)
	const ref = VaultCode.reference("github", "token")
	assert.strictEqual(ref, "⟦vault:github/token⟧")
	assert.deepStrictEqual(
		VaultCode.find({
			headers: { authorization: "Bearer " + ref },
			list: [ref, "⟦vault:github_2/API key⟧"],
			other: 1,
		}),
		[
			{ alias: "github", field: "token" },
			{ alias: "github_2", field: "API key" },
		],
	)
	// A changed reference is only text.
	assert.deepStrictEqual(
		VaultCode.find({ text: Str.replace("⟧", "")(ref) }),
		[],
	)
})

it("redact takes values and their common encodings out of results", () => {
	const secrets = [{ key: "github/token", value: secret }]
	const bytes = Buffer.from(secret)
	const value = {
		plain: "token " + secret,
		base64: bytes.toString("base64"),
		base64url: bytes.toString("base64url"),
		hex: Str.toUpperCase(bytes.toString("hex")),
		url: "https://example.com/?t=" + encodeURIComponent(secret),
		json: JSON.stringify({ quoted: secret + '"' }),
		[secret]: "key",
		short: "ab",
	}
	const text = JSON.stringify(VaultCode.redact(value, secrets))
	assert.strictEqual(Str.includes(secret)(text), false)
	assert.strictEqual(Str.includes(bytes.toString("base64"))(text), false)
	assert.strictEqual(
		Str.includes(Str.toUpperCase(bytes.toString("hex")))(text),
		false,
	)
	assert.strictEqual(Str.includes(encodeURIComponent(secret))(text), false)
	assert.match(text, /⟦hidden:github\/token⟧/)
	// A value shorter than the limit is not taken out, or every short word could go.
	assert.strictEqual(
		VaultCode.redactText("a b c", [{ key: "x/y", value: "b" }]),
		"a b c",
	)
})

// The sandbox looks for its worker file on disk, so it needs a real file system.
layer(Layer.merge(NodeFileSystem.layer, ErrorRecordsFixture.layer))((it) => {
	it.effect("a program sees only references in `vault`, never values", () =>
		Effect.gen(function* () {
			const sandbox = yield* make
			const outcome = yield* sandbox.run(
				{
					code: `
						const before = vault.github.token
						try { vault.github.token = "changed" } catch {}
						return { ref: vault.github.token, before, items: Object.keys(vault), frozen: Object.isFrozen(vault.github) }
					`,
					bindings: [],
					vault: [{ alias: "github", fields: ["token"] }],
					seed: 1,
					clock: 1,
					limits: {
						timeoutMs: 2_000,
						memoryBytes: 32 * 1024 * 1024,
						outputBytes: 4_096,
					},
				},
				() => Effect.succeedNone,
			)
			assert.deepStrictEqual(outcome._tag === "Done" && outcome.value, {
				ref: "⟦vault:github/token⟧",
				before: "⟦vault:github/token⟧",
				items: ["github"],
				frozen: true,
			})
		}),
	)
})
