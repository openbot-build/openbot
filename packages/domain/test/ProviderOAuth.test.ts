import { assert, describe, it } from "@effect/vitest"
import * as Models from "../src/Models.ts"
import { Redacted, Schema } from "effect"
import * as ProviderOAuth from "../src/ProviderOAuth.ts"

describe("provider sign-in addresses", () => {
	it("uses only an exact local callback with a port", () => {
		const valid = Schema.is(ProviderOAuth.ProviderOAuthRedirectUri)
		assert.isTrue(valid("http://127.0.0.1:1455/auth/callback"))
		assert.isTrue(valid("http://127.0.0.1:54321/auth/callback"))
		for (const value of [
			"https://127.0.0.1:1455/auth/callback",
			"http://localhost:1455/auth/callback",
			"http://127.0.0.1/auth/callback",
			"http://127.0.0.1:0/auth/callback",
			"http://127.0.0.1:65536/auth/callback",
			"http://127.0.0.1:1455/auth/callback?next=other",
			"http://127.0.0.1:1455/auth/callback#other",
			"http://user@127.0.0.1:1455/auth/callback",
			"http://other.example:1455/auth/callback",
		])
			assert.isFalse(valid(value), value)
	})

	it("allows a code or an error in the local callback", () => {
		const valid = Schema.is(ProviderOAuth.ProviderOAuthCallbackUrl)
		assert.isTrue(
			valid(
				"http://127.0.0.1:1455/auth/callback?code=code&state=state&client_id=client",
			),
		)
		assert.isTrue(
			valid(
				"http://127.0.0.1:1455/auth/callback?error=access_denied&state=state",
			),
		)
		for (const value of [
			"https://other.example/auth/callback?code=code",
			"http://localhost:1455/auth/callback?code=code",
			"http://127.0.0.1:1455/other?code=code",
			"http://127.0.0.1:1455/auth/callback?code=code#other",
		])
			assert.isFalse(valid(value), value)
	})
})

it("keeps API key inputs and checks ChatGPT inputs", () => {
	const base = { name: "Test", models: [] }
	const valid = Schema.is(Models.CreateModelProviderRequest)
	assert.isTrue(valid({ ...base, kind: "chatgpt" }))
	assert.isFalse(
		valid({ ...base, kind: "chatgpt", endpoint: "https://other.example" }),
	)
	assert.isFalse(
		valid({ ...base, kind: "chatgpt", apiKey: Redacted.make("key") }),
	)
	assert.isTrue(
		valid({ ...base, kind: "openai", apiKey: Redacted.make("key") }),
	)
	assert.isFalse(valid({ ...base, kind: "openai" }))
	const platform = Schema.is(Models.CreatePlatformModelProviderRequest)
	assert.isTrue(
		platform({ ...base, kind: "chatgpt", availability: { _tag: "All" } }),
	)
	assert.isFalse(
		platform({ ...base, kind: "openai", availability: { _tag: "All" } }),
	)
})
