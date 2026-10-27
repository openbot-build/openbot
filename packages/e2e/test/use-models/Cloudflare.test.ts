import { assert, layer } from "@effect/vitest"
import { PgClient } from "@effect/sql-pg"
import { SqlClient } from "effect/sql"
import { NodeServices } from "@effect/platform-node"
import {
	BillingApi,
	ChatCommandReceipt,
	ChatResponse,
	ChatView,
	ExecutionsApi,
	UserTokensApi,
} from "@openbot-build/api"
import { Item } from "@openbot-build/core"
import {
	Array as Arr,
	Clock,
	Config,
	Effect,
	FileSystem,
	Layer,
	Option,
	Redacted,
	Schema,
	String as Str,
} from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import {
	Caller,
	Cloudflare,
	DevelopmentLogin,
	Messages,
	PostgresTest,
} from "@openbot-build/openbot/testing"
const { origin, keepPrivate, environment, migrate, seedSession, start } =
	Cloudflare
const { browser } = DevelopmentLogin
type Send = Messages.Send

const Created = Schema.Struct({ id: Schema.String })
const Turns = Schema.Struct({ items: Schema.Array(Created) })
const Items = Schema.Struct({ items: Schema.Array(Item.Record) })
const Usage = Schema.Struct({ items: Schema.Array(BillingApi.UsageEvent) })

/** Reads a response without putting a provider key or account address in an error. */
const created = (call: Caller.Call, status: number) =>
	Effect.gen(function* () {
		const response = yield* call
		assert.strictEqual(response.status, status)
		return yield* Caller.json(Created)(response)
	})

/** Waits on the real execution stream, then checks its saved text and final state. */
const finish = Effect.fn("CloudflareE2E.finish")(function* (
	send: Send,
	receipt: ChatCommandReceipt,
) {
	const response = yield* send(
		`/v1/executions/${receipt.executionId}/observe`,
		"GET",
	)
	assert.strictEqual(response.status, 200)
	const events = yield* response.text.pipe(Effect.timeout("90 seconds"))
	assert.match(events, /event: execution/)
	assert.match(events, /"_tag":"Text"/)
	const view = yield* send(`/v1/chats/${receipt.chat}`, "GET").pipe(
		Effect.flatMap(Caller.json(ChatView)),
	)
	assert.strictEqual(view.response?.status, "completed")
	assert.strictEqual(view.response?.error, null)
	assert.ok(view.response !== null)
	const text = Arr.join(
		Arr.flatMap(view.response.output, (item) =>
			Arr.map(item.content, (part) => part.text),
		),
		"",
	)
	assert.ok(Str.trim(text).length > 0)
	const page = yield* send(
		`/v1/executions/${receipt.executionId}/events`,
		"GET",
	).pipe(Effect.flatMap(Caller.json(ExecutionsApi.EventPage)))
	assert.strictEqual(page.terminal, true)
	assert.ok(page.events.length > 0)
	const tail = yield* send(
		`/v1/executions/${receipt.executionId}/events?afterSequence=${page.afterSequence}`,
		"GET",
	).pipe(Effect.flatMap(Caller.json(ExecutionsApi.EventPage)))
	assert.strictEqual(tail.events.length, 0)
	assert.strictEqual(tail.terminal, true)
	return {
		text,
		eventCount: page.events.length,
		toolSteps: Arr.filter(
			page.events,
			(event) =>
				event.body._tag === "StepStarted" &&
				Str.startsWith("tool:")(event.body.step),
		).length,
	}
})

// The database, servers, and provider use real time. This test makes paid model calls.
layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer), {
	excludeTestServices: true,
})((it) => {
	it.effect(
		"real model calls work through the built API with a cookie and a user token",
		(context) =>
			Effect.gen(function* () {
				const enabled = yield* Config.Boolean("OPENBOT_E2E_LIVE").pipe(
					Config.withDefault(false),
				)
				if (!enabled) {
					return yield* Effect.sync(() => context.skip())
				}
				const endpoint = yield* Config.Redacted(
					"OPENBOT_E2E_CLOUDFLARE_ENDPOINT",
				)
				const apiKey = yield* Config.Redacted("OPENBOT_E2E_CLOUDFLARE_KEY")
				const upstream = yield* Config.String(
					"OPENBOT_E2E_CLOUDFLARE_MODEL",
				).pipe(Config.withDefault("@cf/meta/llama-3.3-70b-instruct-fp8-fast"))
				const evidencePath = yield* Config.String("OPENBOT_E2E_EVIDENCE").pipe(
					Config.option,
				)
				const fs = yield* FileSystem.FileSystem
				const started = yield* Clock.currentTimeMillis
				const database = yield* PostgresTest.start
				const env = environment(database.url)
				yield* migrate(env)
				const session = yield* seedSession(env)
				if (Option.isSome(evidencePath)) {
					const target = evidencePath.value + ".failures.json"
					const account = /\/accounts\/([^/]+)/.exec(
						Redacted.value(endpoint),
					)?.[1]
					yield* Effect.addFinalizer(() =>
						Cloudflare.writeFailureCauses(
							database.url,
							env.OPENBOT_SECRET_KEYS,
							target,
							[
								Redacted.value(apiKey),
								Redacted.value(endpoint),
								account ?? "no-account",
							],
						).pipe(Effect.orDie),
					)
				}
				const address = yield* start(env)
				const cookie = browser(address, origin, session)
				assert.strictEqual(
					(yield* HttpClient.get(address + "/v1/chats")).status,
					401,
				)
				const crossSite = Caller.withCookie({
					address,
					publicOrigin: "https://outside.example.com",
				})
				assert.strictEqual(
					(yield* crossSite(session, "/v1/user/tokens", "POST", { name: "No" }))
						.status,
					403,
				)
				const { token, secret } = yield* cookie("/v1/user/tokens", "POST", {
					name: "Live test",
				}).pipe(Effect.flatMap(Caller.json(UserTokensApi.CreatedToken, 201)))
				const keyed = Caller.withToken(address)
				const key: Send = (path, method, payload) =>
					keyed(secret, path, method, payload)
				const modelId = "live-test-model"
				yield* created(
					cookie("/v1/organization/models", "POST", {
						id: modelId,
						name: "Live test model",
						reasoningEfforts: [],
						serviceTiers: [],
						contextWindow: 32000,
						maxOutputTokens: 128,
					}),
					200,
				)
				const provider = yield* keepPrivate(
					created(
						cookie("/v1/organization/model_providers", "POST", {
							kind: "openai-compat",
							name: "Live test provider",
							endpoint: Redacted.value(endpoint),
							apiKey: Redacted.value(apiKey),
							models: [
								{ model: modelId, modelOwner: "organization", upstream },
							],
						}),
						200,
					),
					[
						Redacted.value(apiKey),
						Redacted.value(endpoint),
						/\/accounts\/([^/]+)/.exec(Redacted.value(endpoint))?.[1] ??
							"no-account",
					],
				)
				const bot = yield* created(
					key("/v1/bots", "POST", {
						name: "Live helper",
						role: "Gives short answers",
						instructions:
							"Give a short answer to the person. Do not call tools for plain text questions.",
						model: {
							_tag: "Config.Selection",
							provider: provider.id,
							model: modelId,
						},
					}),
					201,
				)
				const firstInput = {
					input: "Reply with the word river and nothing else.",
					commandKey: "live:first",
				}
				const first = yield* cookie(
					`/v1/bots/${bot.id}/messages`,
					"POST",
					firstInput,
				).pipe(Effect.flatMap(Caller.json(ChatCommandReceipt, 202)))
				const firstResult = yield* finish(key, first)
				assert.match(Str.toLowerCase(firstResult.text), /river/)
				const beforeReplay = yield* cookie(
					"/v1/organization/usage/events",
					"GET",
				).pipe(Effect.flatMap(Caller.json(Usage)))
				const replay = yield* cookie(
					`/v1/bots/${bot.id}/messages`,
					"POST",
					firstInput,
				).pipe(Effect.flatMap(Caller.json(ChatCommandReceipt, 202)))
				assert.strictEqual(replay.executionId, first.executionId)
				assert.strictEqual(replay.turn, first.turn)
				const afterReplay = yield* cookie(
					"/v1/organization/usage/events",
					"GET",
				).pipe(Effect.flatMap(Caller.json(Usage)))
				assert.strictEqual(afterReplay.items.length, beforeReplay.items.length)
				assert.strictEqual(
					(yield* cookie(`/v1/bots/${bot.id}/messages`, "POST", {
						...firstInput,
						input: "A different body",
					})).status,
					409,
				)
				const second = yield* key(`/v1/chats/${first.chat}/messages`, "POST", {
					input:
						"What word did you write in your last answer? Reply with that word only.",
					commandKey: "live:second",
				}).pipe(Effect.flatMap(Caller.json(ChatCommandReceipt, 202)))
				const secondResult = yield* finish(cookie, second)
				assert.match(Str.toLowerCase(secondResult.text), /river/)
				const turns = yield* cookie(
					`/v1/chats/${first.chat}/turns`,
					"GET",
				).pipe(Effect.flatMap(Caller.json(Turns)))
				assert.strictEqual(turns.items.length, 2)
				const saved = yield* key(
					`/v1/chats/${first.chat}/turns/${first.turn}`,
					"GET",
				).pipe(
					Effect.flatMap(
						Caller.json(Schema.Struct({ response: ChatResponse })),
					),
				)
				assert.strictEqual(saved.response.status, "completed")
				const items = yield* key(`/v1/chats/${first.chat}/items`, "GET").pipe(
					Effect.flatMap(Caller.json(Items)),
				)
				assert.ok(items.items.length >= 4)
				const usage = yield* cookie(
					"/v1/organization/usage/events",
					"GET",
				).pipe(Effect.flatMap(Caller.json(Usage)))
				const calls = Arr.filter(
					usage.items,
					(item) => item.provider === provider.id,
				)
				assert.ok(calls.length >= 2)
				assert.ok(Arr.every(calls, (item) => item.status === "confirmed"))
				assert.ok(
					Arr.every(
						calls,
						(item) =>
							(item.inputUncached ?? 0) + (item.inputCacheRead ?? 0) > 0,
					),
				)
				assert.ok(Arr.every(calls, (item) => (item.outputText ?? 0) > 0))
				assert.ok(Arr.some(calls, (item) => item.tokenId === token.id))
				assert.ok(Arr.some(calls, (item) => item.tokenId === null))
				if (Option.isSome(evidencePath))
					yield* fs.writeFileString(
						evidencePath.value,
						yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
							status: "chat passed; tool check pending",
							model: upstream,
							turns: turns.items.length,
							modelCalls: calls.length,
							checks: [
								"production entry",
								"session setup without index work",
								"cookie",
								"user token",
								"anonymous denial",
								"origin denial",
								"stream",
								"event cursor",
								"history",
								"context",
								"command replay",
								"key conflict",
								"usage",
							],
						}),
					)
				const toolReceipt = yield* key(
					`/v1/chats/${first.chat}/messages`,
					"POST",
					{
						input:
							"Call openbot_todos with items set to an empty list. Then reply with done. Make just this one tool call.",
						commandKey: "live:tool",
					},
				).pipe(Effect.flatMap(Caller.json(ChatCommandReceipt, 202)))
				const toolResult = yield* finish(cookie, toolReceipt)
				assert.ok(toolResult.toolSteps > 0)
				const toolItems = yield* cookie(
					`/v1/chats/${first.chat}/turns/${toolReceipt.turn}/items`,
					"GET",
				).pipe(Effect.flatMap(Caller.json(Items)))
				const toolParts = Arr.flatMap(toolItems.items, (item) =>
					Arr.flatMap(item.content.content, (message) =>
						message.role === "tool" ? message.content : [],
					),
				)
				assert.ok(
					Arr.some(
						toolParts,
						(part) =>
							part.type === "tool-result" &&
							part.name === "openbot_todos" &&
							!part.isFailure,
					),
				)
				assert.match(Str.toLowerCase(toolResult.text), /done/)
				const allUsage = yield* cookie(
					"/v1/organization/usage/events",
					"GET",
				).pipe(Effect.flatMap(Caller.json(Usage)))
				const allCalls = Arr.filter(
					allUsage.items,
					(item) => item.provider === provider.id,
				)
				assert.ok(allCalls.length >= calls.length + 2)
				assert.ok(Arr.every(allCalls, (item) => item.status === "confirmed"))
				assert.strictEqual(
					(yield* cookie(`/v1/user/tokens/${token.id}`, "DELETE")).status,
					204,
				)
				assert.strictEqual((yield* key("/v1/chats", "GET")).status, 401)
				yield* Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient
					const rows = yield* sql<{ readonly count: number }>`select
						count(*)::integer as count from openbot_execution_failures`
					assert.deepStrictEqual(rows, [{ count: 0 }])
				}).pipe(
					Effect.provide(PgClient.layer({ url: Redacted.make(database.url) })),
				)
				if (Option.isSome(evidencePath))
					yield* fs.writeFileString(
						evidencePath.value,
						yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
							status: "passed",
							model: upstream,
							elapsedMillis: (yield* Clock.currentTimeMillis) - started,
							turns: turns.items.length + 1,
							modelCalls: allCalls.length,
							inputTokens: Arr.reduce(
								allCalls,
								0,
								(sum, call) =>
									sum + (call.inputUncached ?? 0) + (call.inputCacheRead ?? 0),
							),
							outputTokens: Arr.reduce(
								allCalls,
								0,
								(sum, call) => sum + (call.outputText ?? 0),
							),
							events: [
								firstResult.eventCount,
								secondResult.eventCount,
								toolResult.eventCount,
							],
							toolSteps: toolResult.toolSteps,
							checks: [
								"production entry",
								"session setup without index work",
								"cookie",
								"user token",
								"anonymous denial",
								"origin denial",
								"stream",
								"event cursor",
								"history",
								"context",
								"command replay",
								"key conflict",
								"usage",
								"token revocation",
								"tool call and next model step",
								"no saved execution failures",
							],
						}),
					)
			}),
		{ timeout: 180000 },
	)
})
