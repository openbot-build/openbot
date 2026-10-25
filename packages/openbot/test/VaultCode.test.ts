import { assert, it } from "@effect/vitest"
import { VaultsApi } from "@openbot-build/api"
import { Client } from "@openbot-build/protocol"
import { Effect, Result } from "effect"
import type { Binding } from "../src/apps/Bindings.ts"
import { make as makeSandbox } from "../src/code/Sandbox.ts"
import * as VaultCode from "../src/vaults/CodeMode.ts"
import type { Usable, Vaults } from "../src/vaults/Vaults.ts"
import { VaultReadFailed } from "../src/vaults/Readers.ts"

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

/** Only `reveal` is used by Code Mode. */
const vaults = (
	reveal: (typeof Vaults.Service)["reveal"],
): typeof Vaults.Service => ({ reveal }) as unknown as typeof Vaults.Service

const binding = (
	answer: (input: unknown) => ReturnType<Binding["perform"]>,
	kind: "tool" | "resource" = "tool",
	name = "send",
): Binding => ({
	name: "openbot_send",
	source: {
		connectionId: "conn-1",
		connectionName: "GitHub",
		cardUrl: "https://apps.example.com/card",
		appName: "GitHub",
		remoteIndex: 0,
		revision: 0,
		kind,
		name,
	},
	schema: { type: "object" },
	description: "Sends.",
	needsDecision: kind === "tool",
	readOnly: false,
	perform: answer,
})

it("each Vault item gets a stable name, and references are found in all strings", () => {
	const entries = VaultCode.aliases([
		usable("vli_b", "github", []),
		usable("vli_a", "github", []),
	])
	assert.deepStrictEqual(
		entries.map((entry) => [entry.alias, entry.usable.item.id]),
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
	assert.deepStrictEqual(VaultCode.find({ text: ref.replace("⟧", "") }), [])
})

it("redact takes values and their common encodings out of results", () => {
	const secrets = [{ key: "github/token", value: secret }]
	const bytes = Buffer.from(secret)
	const value = {
		plain: "token " + secret,
		base64: bytes.toString("base64"),
		base64url: bytes.toString("base64url"),
		hex: bytes.toString("hex").toUpperCase(),
		url: "https://example.com/?t=" + encodeURIComponent(secret),
		json: JSON.stringify({ quoted: secret + '"' }),
		[secret]: "key",
		short: "ab",
	}
	const text = JSON.stringify(VaultCode.redact(value, secrets))
	assert.strictEqual(text.includes(secret), false)
	assert.strictEqual(text.includes(bytes.toString("base64")), false)
	assert.strictEqual(text.includes(bytes.toString("hex").toUpperCase()), false)
	assert.strictEqual(text.includes(encodeURIComponent(secret)), false)
	assert.match(text, /⟦hidden:github\/token⟧/)
	// A value shorter than the limit is not taken out, or every short word could go.
	assert.strictEqual(
		VaultCode.redactText("a b c", [{ key: "x/y", value: "b" }]),
		"a b c",
	)
})

it.effect(
	"a guarded call gets the value only for an allowed tool, and the result comes back without it",
	() =>
		Effect.gen(function* () {
			const entries = VaultCode.aliases([
				usable("vli_a", "github", [
					{ _tag: "App", connection: "conn-1", tool: "send" },
				]),
			])
			let sent: unknown
			const echo = binding((input) =>
				Effect.sync(() => {
					sent = input
					return {
						_tag: "Completed",
						result: {
							content: [{ type: "text", text: JSON.stringify(input) }],
						},
					} as const
				}),
			)
			const reveal = vaults((_organization, item, fields) =>
				item === "vli_a" && fields.join() === "token"
					? Effect.succeed(new Map([["token", secret]]))
					: Effect.fail(VaultReadFailed.make({ message: "No such item" })),
			)
			const ref = VaultCode.reference("github", "token")
			const args = { authorization: "Bearer " + ref, id: 1 }

			const denials = [
				[VaultCode.guard(reveal, "org", [], echo, args), /no Vault item/],
				[
					VaultCode.guard(reveal, "org", entries, echo, {
						a: "⟦vault:github/password⟧",
					}),
					/no field password/,
				],
				[
					VaultCode.guard(
						reveal,
						"org",
						entries,
						binding(echo.perform, "tool", "other"),
						args,
					),
					/may not go to GitHub \/ other/,
				],
				[
					VaultCode.guard(
						reveal,
						"org",
						entries,
						binding(echo.perform, "resource"),
						args,
					),
					/only go to App tools/,
				],
			] as const
			for (const [result, message] of denials) {
				assert.ok(Result.isFailure(result))
				if (Result.isFailure(result)) assert.match(result.failure, message)
			}
			// Without a reference, the binding stays as it is.
			const plain = VaultCode.guard(reveal, "org", entries, echo, { id: 1 })
			assert.ok(Result.isSuccess(plain) && plain.success.binding === echo)

			const guarded = VaultCode.guard(reveal, "org", entries, echo, args)
			assert.ok(Result.isSuccess(guarded))
			if (!Result.isSuccess(guarded)) return
			assert.strictEqual(guarded.success.references, 1)
			const result = yield* guarded.success.binding.perform(args)
			assert.deepStrictEqual(sent, { authorization: "Bearer " + secret, id: 1 })
			const text = JSON.stringify(result)
			assert.strictEqual(text.includes(secret), false)
			assert.match(text, /Bearer ⟦hidden:github\/token⟧/)

			// A failure of the App comes back without the value too.
			const failing = VaultCode.guard(
				reveal,
				"org",
				entries,
				binding(() =>
					Effect.fail(
						new Client.ToolFailure({
							result: {
								content: [{ type: "text", text: "bad token " + secret }],
								isError: true,
							},
						}),
					),
				),
				args,
			)
			assert.ok(Result.isSuccess(failing))
			if (!Result.isSuccess(failing)) return
			const error = yield* Effect.flip(failing.success.binding.perform(args))
			assert.strictEqual(JSON.stringify(error).includes(secret), false)
		}),
)

it.effect("a program sees only references in `vault`, never values", () =>
	Effect.gen(function* () {
		const sandbox = yield* makeSandbox
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
