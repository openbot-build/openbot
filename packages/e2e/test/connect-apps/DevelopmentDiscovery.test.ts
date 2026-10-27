import { assert, layer } from "@effect/vitest"

import * as Client from "@openbot-build/client"

import { AppDiscoveryFailed, AppDiscoveryResult } from "@openbot-build/api"
import { Context, Effect, Layer, Result, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

import * as Development from "@openbot-build/openbot/Development"
import { Caller, PostgresTest } from "@openbot-build/openbot/testing"
import {
	signIn,
	settings,
	platform,
	toJson,
	migrate,
	launch,
	fetchWith,
} from "../support/Development.ts"

// These journeys use real servers and the real clock.
layer(platform, { excludeTestServices: true })((it) => {
	it.effect(
		"development HTTP discovery uses fixed local data with standard authentication",
		() =>
			Effect.gen(function* () {
				const database = yield* PostgresTest.start
				const options = settings(database.url)
				const publicOrigin = options.auth.publicOrigin
				yield* migrate(options)
				const { address } = yield* launch(Development.layer(options))
				const { cookie } = yield* signIn(address, publicOrigin)
				const { api } = Context.get(
					yield* Layer.build(
						Client.layer({ baseUrl: address }).pipe(
							Layer.provide(fetchWith(cookie, publicOrigin)),
						),
					),
					Client.Client,
				)
				const discover = (input: string) =>
					api.apps.discoverApp({ payload: { input } })
				for (const input of [
					"app.development.test",
					"https://app.development.test/card.json",
				]) {
					const result = yield* discover(input)
					assert.ok(result._tag === "Single")
					assert.strictEqual(
						result.candidate.cardUrl,
						"https://app.development.test/card.json",
					)
					assert.strictEqual(
						result.candidate.card.name,
						"app.development.test/simulated-app",
					)
					assert.strictEqual(result.candidate.sources[0]?.originalInput, input)
					assert.strictEqual(
						result.candidate.endpoints[0]?.remote.url,
						"https://app.development.test/mcp",
					)
				}
				const failures: ReadonlyArray<readonly [string, string]> = [
					["unknown.development.test", "NoDeclaration"],
					["https://publisher.example/card.json", "NoDeclaration"],
					["http://app.development.test/card.json", "InvalidInput"],
					[
						"https://name:secret@app.development.test/card.json",
						"InvalidInput",
					],
					["not a link", "InvalidInput"],
				]
				for (const [input, reason] of failures) {
					const result = yield* Effect.result(discover(input))
					assert.ok(Result.isFailure(result))
					assert.ok(Schema.is(AppDiscoveryFailed)(result.failure))
					assert.strictEqual(result.failure.reason, reason)
				}
				const valid = yield* toJson({ input: "app.development.test" })
				const request = (headers: Record<string, string>, body = valid) =>
					HttpClient.execute(
						HttpClientRequest.post(address + "/v1/apps/discover", {
							headers,
						}).pipe(HttpClientRequest.bodyText(body, "application/json")),
					)
				for (const [headers, status] of [
					[{}, 401],
					[{ cookie }, 403],
					[{ cookie, origin: "https://foreign.development.test" }, 403],
					[
						{
							cookie: "__Host-openbot-session=invalid",
							origin: publicOrigin,
						},
						401,
					],
				] satisfies ReadonlyArray<readonly [Record<string, string>, number]>) {
					const response = yield* request(headers)
					assert.strictEqual(response.status, status)
					yield* response.text
				}
				const session = yield* request({ cookie, origin: publicOrigin })
				assert.strictEqual(session.status, 200)
				assert.strictEqual(
					(yield* Caller.json(Schema.toCodecJson(AppDiscoveryResult))(session))
						._tag,
					"Single",
				)
				const malformed = yield* request({ cookie, origin: publicOrigin }, "{")
				assert.strictEqual(malformed.status, 400)
				yield* malformed.text
			}),
		{ timeout: 30000 },
	)
})
