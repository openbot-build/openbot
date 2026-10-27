import { assert, layer } from "@effect/vitest"
import { AppExecution } from "@openbot-build/api"
import { Apps, BrowserHost } from "@openbot-build/openbot/testing"
import { Effect, Schema, String as Str } from "effect"

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"App assistance shows public candidates and the account's access needs without sending private context or granting access",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({
					publicOrigin: "https://openbot.fixture.test",
				})
				const alice = yield* host.login("assistance-alice")
				const assistance = yield* Apps.assistance(host, alice.identity)
				assert.strictEqual((yield* assistance.queries).length, 0)
				assert.strictEqual(assistance.searchName, "openbot_search_apps_2")
				const result = yield* assistance.search({
					query: "document",
					privateHistory: "A private document that must never reach discovery",
				})
				const candidates = yield* Schema.decodeUnknownEffect(
					AppExecution.Assistance.cases.AppCandidates,
				)(result)
				assert.strictEqual(candidates.page.apps.length, 0)
				assert.deepStrictEqual(yield* assistance.queries, [
					{ query: "document" },
				])
				const invalid = yield* assistance.search({
					query: Str.repeat(201)("x"),
				})
				assert.strictEqual(invalid._tag, "AppAssistanceFailed")
				assert.strictEqual((yield* assistance.queries).length, 1)
				const access = yield* assistance.access
				assert.deepStrictEqual(access, { _tag: "AppAccess", connections: [] })
				// An App that is not in the Index is not an Index that is down.
				assert.deepStrictEqual(
					yield* assistance.details({
						cardUrl: "https://apps.fixture.test/missing/card.json",
					}),
					{
						_tag: "AppAssistanceFailed",
						reason: "IndexNotFound",
						message: "This App is not in the selected public Index.",
					},
				)
				const failed = yield* assistance.offlineSearch({ query: "document" })
				assert.strictEqual(failed._tag, "AppAssistanceFailed")
				assert.deepStrictEqual(yield* assistance.access, access)
			}),
	)
})
