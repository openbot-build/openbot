import { assert, layer } from "@effect/vitest"
import { ConnectionsApi as Api } from "@openbot-build/api"
import {
	AppFixture as Fixture,
	BrowserHost,
	Caller,
} from "@openbot-build/openbot/testing"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"ordinary HTTP clients prepare and confirm protected Apps without trusting caller authorization claims",
		() =>
			Effect.gen(function* () {
				const publisher = yield* Fixture.start()
				const host = yield* BrowserHost.start({
					publicOrigin: "https://openbot.fixture.test",
					discovery: publisher.discovery,
					appProbe: publisher.probe,
				})
				const user = yield* host.login("app-user")
				const address = yield* host.address
				const call = Caller.withCookie({
					address,
					publicOrigin: "https://openbot.fixture.test",
				})
				const prepared = yield* call(
					user.session,
					"/v1/connection-drafts",
					"POST",
					{ input: publisher.origin + "/card?edition=team" },
				)
				assert.strictEqual(prepared.status, 201)
				const draft = yield* HttpClientResponse.schemaBodyJson(
					Api.ConnectionDraft,
				)(prepared)
				const response = yield* call(user.session, "/v1/connections", "POST", {
					draftId: draft.id,
					revision: 0,
					cardUrl: publisher.origin + "/card?edition=team",
					remoteIndex: 1,
					name: "Protected account",
					values: {},
					confirmed: true,
					requiresAuthorization: false,
				})
				assert.strictEqual(response.status, 201)
				const connection = yield* HttpClientResponse.schemaBodyJson(
					Api.Connection,
				)(response)
				assert.strictEqual(connection.availability._tag, "PendingAuthorization")
				assert.strictEqual(
					(yield* HttpClient.get(address + "/v1/connections")).status,
					401,
				)
				const badOrigin = yield* Caller.withCookie({
					address,
					publicOrigin: "https://foreign.test",
				})(user.session, "/v1/connection-drafts", "POST", {
					input: publisher.origin + "/card",
				})
				assert.strictEqual(badOrigin.status, 403)
			}),
	)
})
