import { Execution } from "@openbot-build/domain"
import { assert, layer } from "@effect/vitest"
import {
	AuthApi,
	BillingApi,
	ChatSummary,
	ModelProvidersApi,
	Settings,
} from "@openbot-build/api"
import { Turn } from "@openbot-build/core"
import { Array as Arr, Effect, Option, pipe, Schema } from "effect"
import { BrowserHost, Caller, Messages } from "@openbot-build/openbot/testing"

const { bot, message, settled } = Messages
type Send = Messages.Send

const publicOrigin = "https://billing.example.com"

/** Each model call of the fake provider uses these tokens. */
const usage = {
	prompt_tokens: 1000,
	completion_tokens: 500,
	total_tokens: 1500,
	prompt_tokens_details: { cached_tokens: 200 },
}
/** Micro-USD for one million tokens. */
const price = {
	inputUncached: 2_000_000,
	inputCacheRead: 500_000,
	inputCacheWrite: 0,
	output: 8_000_000,
	outputReasoning: null,
}
/** A price with one tier for every input size, at every time. */
const flat = { tiers: [{ upToInputTokens: null, ...price }] }
/** 800 uncached, 200 cached and 500 output tokens: 1600 + 100 + 4000. */
const callCost = 5700

/** The part of a model request that the fake provider reads. */
const ModelRequest = Schema.fromJsonString(
	Schema.Struct({ stream: Schema.optionalKey(Schema.Boolean) }),
)
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

/** A model API in the OpenAI chat format. It answers every call with the same text and usage. */
const providerFetch = (request: Request) =>
	Effect.gen(function* () {
		const body = yield* Schema.decodeEffect(ModelRequest)(
			yield* Effect.promise(() => request.text()),
		)
		const chunk = {
			id: "chat_1",
			model: "upstream",
			created: 1,
			object: "chat.completion.chunk",
		}
		if (body.stream !== true)
			return Response.json({
				...chunk,
				object: "chat.completion",
				choices: [
					{
						index: 0,
						finish_reason: "stop",
						message: { role: "assistant", content: '{"changes":[]}' },
					},
				],
				usage,
			})
		const events = yield* Effect.forEach(
			[
				{
					...chunk,
					choices: [
						{
							index: 0,
							delta: { role: "assistant", content: "Done." },
							finish_reason: null,
						},
					],
				},
				{
					...chunk,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage,
				},
			],
			(event) => encodeJson(event),
		)
		return new Response(
			pipe(
				events,
				Arr.map((event) => `data: ${event}\n\n`),
				Arr.join(""),
			) + "data: [DONE]\n\n",
			{ headers: { "content-type": "text/event-stream" } },
		)
	}).pipe(Effect.orDie)

/**
 * Reads the JSON body of an answer with a schema, and checks its status. The
 * server writes the JSON form of each schema, where a missing optional value is null.
 */
const json = <S extends Schema.Constraint>(
	schema: S,
	call: Caller.Call,
	status = 200,
) => Effect.flatMap(call, Caller.json(Schema.toCodecJson(schema), status))

/** One page of usage events. */
const UsageEvents = Schema.Struct({
	items: Schema.Array(BillingApi.UsageEvent),
})

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"model calls are metered, priced, limited by budgets and paid with credits",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({
					publicOrigin,
					platformAdmins: ["root@example.com"],
					registryModels: true,
					platformFetch: providerFetch,
					bots: { memory: false },
				})
				const send = Caller.withCookie({
					address: yield* host.address,
					publicOrigin,
				})

				// Alice signs in first, so the others join her organization.
				const alice = yield* host.login("alice")
				const bob = yield* host.login("bob")
				const root = yield* host.login("root")
				yield* host.defaultBot(alice.session)
				const organizationId = alice.identity.organizationId

				// The platform shares a model that it pays for.
				yield* json(
					ModelProvidersApi.Model,
					send(root.session, "/v1/platform/models", "POST", {
						id: "large",
						name: "Large",
						reasoningEfforts: [],
						serviceTiers: [],
						availability: { _tag: "All" },
					}),
				)
				const platformProvider = yield* json(
					ModelProvidersApi.ModelProvider,
					send(root.session, "/v1/platform/model_providers", "POST", {
						kind: "openai-compat",
						name: "Platform",
						endpoint: "https://platform-models.example.com/v1",
						apiKey: "sk-platform-0123456789",
						models: [{ model: "large", modelOwner: "platform" }],
						availability: { _tag: "All" },
					}),
				)
				// Alice adds a model with the key of her organization.
				yield* json(
					ModelProvidersApi.Model,
					send(alice.session, "/v1/organization/models", "POST", {
						id: "small",
						name: "Small",
						reasoningEfforts: [],
						serviceTiers: [],
					}),
				)
				const ownProvider = yield* json(
					ModelProvidersApi.ModelProvider,
					send(alice.session, "/v1/organization/model_providers", "POST", {
						kind: "openai-compat",
						name: "Own key",
						endpoint: "https://own-models.example.com/v1",
						apiKey: "sk-own-0123456789",
						models: [{ model: "small", modelOwner: "organization" }],
					}),
				)

				// Prices. A provider can only price the models that it offers.
				const platformPrice = yield* json(
					BillingApi.ModelPrice,
					send(
						root.session,
						`/v1/platform/model_providers/${platformProvider.id}/prices`,
						"PUT",
						{
							model: "large",
							// Calls of this test have 1000 input tokens, so they use the second tier.
							tiers: [
								{ upToInputTokens: 500, ...price, output: 99_000_000 },
								{ upToInputTokens: null, ...price },
							],
						},
					),
				)
				assert.strictEqual(platformPrice.timeZone, "UTC")
				assert.deepStrictEqual(platformPrice.periods, [])
				yield* json(
					BillingApi.ModelPrice,
					send(
						alice.session,
						`/v1/organization/model_providers/${ownProvider.id}/prices`,
						"PUT",
						{ model: "small", ...flat },
					),
				)
				const unknown = yield* json(
					ModelProvidersApi.ModelProviderInvalid,
					send(
						alice.session,
						`/v1/organization/model_providers/${ownProvider.id}/prices`,
						"PUT",
						{ model: "large", ...flat },
					),
					400,
				)
				assert.strictEqual(unknown._tag, "ModelProviderInvalid")
				const catalog = yield* json(
					ModelProvidersApi.ModelCatalog,
					send(alice.session, "/v1/organization/model_catalog"),
				)
				assert.strictEqual(
					pipe(
						Arr.findFirst(
							catalog.models,
							(model) => model.provider === platformProvider.id,
						),
						Option.flatMapNullishOr((model) => model.price?.tiers[1]?.output),
						Option.getOrUndefined,
					),
					price.output,
				)

				const asAlice: Send = (path, method, payload) =>
					send(alice.session, path, method, payload)
				/** A Bot of Alice that uses this model. Its Chats use the model too. */
				const botWith = (provider: string, model: string) =>
					bot(asAlice, {
						name: "Billing " + model,
						model: { _tag: "Config.Selection", provider, model },
					})
				/** Sends one message to the Bot and gives the status that its Turn ends with. */
				const turn = (botId: string) =>
					Effect.gen(function* () {
						const receipt = yield* message(asAlice, botId, "Say done")
						assert.ok(receipt.executionId.length > 0)
						assert.ok(receipt.turn !== null)
						yield* settled(asAlice, receipt.chat)
						const read = yield* json(
							Schema.Struct({ turn: Turn.Record }),
							send(
								alice.session,
								`/v1/chats/${receipt.chat}/turns/${receipt.turn}`,
							),
						)
						assert.ok(Turn.isTerminal(read.turn.status))
						return {
							status: read.turn.status,
							execution: yield* json(
								Execution.Record,
								send(alice.session, `/v1/executions/${receipt.executionId}`),
							),
						}
					})
				/** Sends one message to the Bot and checks that its Turn completes. */
				const completed = (botId: string) =>
					Effect.gen(function* () {
						const { status } = yield* turn(botId)
						assert.strictEqual(status._tag, "Completed")
					})
				/**
				 * Sends one message to the Bot and checks that the billing stops its
				 * Turn before the model call. No credits and a spent hard budget give
				 * the same safe failure class. The inside reason stays in the error log.
				 */
				const stopped = (botId: string) =>
					Effect.gen(function* () {
						const { status, execution } = yield* turn(botId)
						assert.ok(status._tag === "Failed", status._tag)
						assert.strictEqual(execution.status, "failed")
						assert.ok(execution.failure !== null)
						assert.strictEqual(execution.failure.category, "forbidden")
						assert.strictEqual(
							status.message,
							`The execution failed. Error ID: ${execution.failure.errorId}`,
						)
					})
				const events = Effect.map(
					json(
						UsageEvents,
						send(alice.session, "/v1/organization/usage/events?limit=200"),
					),
					(page) => page.items,
				)
				const turnEvents = Effect.map(
					events,
					Arr.filter((event) => event.source === "turn"),
				)

				// A Turn on the platform model is metered.
				const platformBot = yield* botWith(platformProvider.id, "large")
				yield* completed(platformBot)
				const [first] = yield* turnEvents
				assert.ok(first !== undefined)
				const platformChat = yield* json(
					Schema.Array(ChatSummary),
					send(alice.session, `/v1/chats?bot=${platformBot}`),
				)
				assert.strictEqual(platformChat.length, 1)
				assert.strictEqual(first.chatId, platformChat[0]?.chat.id)
				assert.strictEqual(first.userId, alice.identity.userId)
				assert.strictEqual(typeof first.turnId, "string")
				assert.strictEqual(typeof first.botId, "string")
				assert.strictEqual(first.providerOwner, "platform")
				assert.strictEqual(first.inputUncached, 800)
				assert.strictEqual(first.inputCacheRead, 200)
				assert.strictEqual(first.outputText, 500)
				assert.strictEqual(first.costMicros, callCost)
				assert.strictEqual(first.priced, true)
				assert.strictEqual(first.charged, false)

				const byMember = yield* json(
					BillingApi.UsageSummary,
					send(alice.session, "/v1/organization/usage?groupBy=member"),
				)
				assert.strictEqual(byMember.groupBy, "member")
				const aliceTotal = Arr.findFirst(
					byMember.items,
					(item) => item.key === alice.identity.userId,
				)
				assert.ok(
					Option.isSome(aliceTotal) && aliceTotal.value.costMicros >= callCost,
				)
				assert.strictEqual(
					(yield* json(
						BillingApi.UsageQueryInvalid,
						send(alice.session, "/v1/organization/usage?from=yesterday"),
						400,
					))._tag,
					"UsageQueryInvalid",
				)
				// A time without a zone is in UTC, whatever the zone of the server is.
				assert.strictEqual(
					(yield* json(
						BillingApi.UsageSummary,
						send(
							alice.session,
							"/v1/organization/usage?from=2020-01-01T00:00:00",
						),
					)).from,
					"2020-01-01T00:00:00.000Z",
				)

				// Credits are off until a platform admin turns them on.
				const credits = `/v1/platform/organizations/${organizationId}/credits`
				assert.strictEqual(
					(yield* json(BillingApi.Credits, send(root.session, credits)))
						.enabled,
					false,
				)
				assert.strictEqual((yield* send(alice.session, credits)).status, 403)
				yield* json(
					BillingApi.Credits,
					send(root.session, credits, "PATCH", { enabled: true }),
				)
				const before = (yield* turnEvents).length
				// No budget exists yet, so only the missing credits stop this Turn.
				yield* stopped(platformBot)
				assert.strictEqual((yield* turnEvents).length, before)
				const grant = yield* json(
					BillingApi.CreditGrant,
					send(root.session, credits + "/grants", "POST", {
						amountMicros: 10_000,
						note: "Trial credits",
					}),
					201,
				)
				assert.strictEqual(grant.amountMicros, 10_000)
				yield* completed(platformBot)
				const charged = pipe(
					yield* events,
					Arr.filter((event) => event.charged),
					Arr.reduce(0, (sum, event) => sum + (event.costMicros ?? 0)),
				)
				assert.ok(charged >= callCost)
				const paid = yield* json(
					BillingApi.Credits,
					send(alice.session, "/v1/organization/credits"),
				)
				assert.strictEqual(paid.enabled, true)
				assert.strictEqual(paid.balanceMicros, 10_000 - charged)
				assert.strictEqual((yield* turnEvents)[0]?.charged, true)

				// The own key of the organization never takes credits.
				const ownBot = yield* botWith(ownProvider.id, "small")
				yield* completed(ownBot)
				const own = (yield* turnEvents)[0]
				assert.strictEqual(own?.providerOwner, "organization")
				assert.strictEqual(own?.charged, false)
				assert.strictEqual(own?.costMicros, callCost)
				assert.strictEqual(
					(yield* json(
						BillingApi.Credits,
						send(alice.session, "/v1/organization/credits"),
					)).balanceMicros,
					10_000 - charged,
				)

				// A spent hard budget stops calls on any key. A soft budget only says so.
				const hard = yield* json(
					BillingApi.Budget,
					send(alice.session, "/v1/organization/budgets", "POST", {
						scope: "organization",
						period: "day",
						limitMicros: 1,
						mode: "hard",
					}),
					201,
				)
				assert.strictEqual(hard.exceeded, true)
				assert.strictEqual(hard.scopeId, organizationId)
				const soft = yield* json(
					BillingApi.Budget,
					send(alice.session, "/v1/organization/budgets", "POST", {
						scope: "member",
						scopeId: alice.identity.userId,
						period: "month",
						limitMicros: 1,
						mode: "soft",
					}),
					201,
				)
				assert.strictEqual(soft.exceeded, true)
				assert.ok(soft.spentMicros >= 3 * callCost)
				const twice = yield* json(
					BillingApi.BudgetConflict,
					send(alice.session, "/v1/organization/budgets", "POST", {
						scope: "organization",
						period: "day",
						limitMicros: 5,
						mode: "soft",
					}),
					409,
				)
				assert.strictEqual(twice._tag, "BudgetConflict")
				const stranger = yield* json(
					BillingApi.BudgetInvalid,
					send(alice.session, "/v1/organization/budgets", "POST", {
						scope: "member",
						scopeId: "not-a-member",
						period: "day",
						limitMicros: 5,
						mode: "hard",
					}),
					400,
				)
				assert.strictEqual(stranger._tag, "BudgetInvalid")
				// An own key never takes credits, so only the hard budget stops this Turn.
				yield* stopped(ownBot)
				const raised = yield* json(
					BillingApi.Budget,
					send(alice.session, "/v1/organization/budgets/" + hard.id, "PATCH", {
						expectedVersion: hard.version,
						limitMicros: 1_000_000,
					}),
				)
				assert.strictEqual(raised.exceeded, false)
				yield* completed(ownBot)
				const removed = yield* send(
					alice.session,
					"/v1/organization/budgets/" + hard.id,
					"DELETE",
				)
				assert.strictEqual(removed.status, 204, yield* removed.text)
				const listed = yield* json(
					Schema.Struct({ items: Schema.Array(BillingApi.Budget) }),
					send(alice.session, "/v1/organization/budgets"),
				)
				assert.deepStrictEqual(
					Arr.map(listed.items, (budget) => budget.id),
					[soft.id],
				)

				// Members cannot read usage or change budgets.
				assert.strictEqual(
					(yield* send(bob.session, "/v1/organization/usage")).status,
					403,
				)
				assert.strictEqual(
					(yield* send(bob.session, "/v1/organization/budgets", "POST", {
						scope: "organization",
						period: "month",
						limitMicros: 5,
						mode: "hard",
					})).status,
					403,
				)

				// The rate limit counts the requests of each caller in each minute.
				const settings = yield* json(
					Settings.PlatformSettings,
					send(root.session, "/v1/platform/settings"),
				)
				assert.deepStrictEqual(settings.rateLimit, { requestsPerMinute: null })
				const limited = yield* json(
					Settings.PlatformSettings,
					send(root.session, "/v1/platform/settings", "PATCH", {
						expectedVersion: settings.version,
						rateLimit: { requestsPerMinute: 3 },
					}),
				)
				const responses = yield* Effect.replicateEffect(
					send(bob.session, "/v1/chats"),
					10,
				)
				const refused = Arr.filter(
					responses,
					(response) => response.status === 429,
				)
				// At most two windows of one minute, so at most six requests pass.
				assert.ok(refused.length >= 4)
				const answer = Arr.head(refused)
				assert.ok(Option.isSome(answer))
				const body = yield* Caller.json(
					Schema.toCodecJson(AuthApi.RateLimited),
					429,
				)(answer.value)
				assert.strictEqual(body._tag, "RateLimited")
				assert.ok(body.retryAfterSeconds >= 1 && body.retryAfterSeconds <= 60)
				yield* json(
					Settings.PlatformSettings,
					send(root.session, "/v1/platform/settings", "PATCH", {
						expectedVersion: limited.version,
						rateLimit: { requestsPerMinute: null },
					}),
				)
				assert.strictEqual((yield* send(bob.session, "/v1/chats")).status, 200)

				// Token rates slow the work down. They never make it fail.
				const platform = yield* json(
					Settings.PlatformSettings,
					send(root.session, "/v1/platform/settings"),
				)
				assert.deepStrictEqual(platform.tokenRate, {
					organization: null,
					member: null,
					bot: null,
					token: null,
				})
				yield* json(
					Settings.PlatformSettings,
					send(root.session, "/v1/platform/settings", "PATCH", {
						expectedVersion: platform.version,
						tokenRate: {
							organization: { tokensPerSecond: 20_000, burstTokens: 1000 },
							member: null,
							bot: null,
							token: null,
						},
					}),
				)
				const organizationSettings = yield* json(
					Settings.OrganizationSettings,
					send(alice.session, "/v1/organization/settings"),
				)
				yield* json(
					Settings.OrganizationSettings,
					send(alice.session, "/v1/organization/settings", "PATCH", {
						expectedVersion: organizationSettings.version,
						tokenRate: {
							organization: null,
							member: { tokensPerSecond: 10_000, burstTokens: 1000 },
							bot: null,
							token: null,
						},
					}),
				)
				// Each call has 1500 tokens, so the bucket goes into debt after each one.
				yield* completed(ownBot)
				yield* completed(ownBot)
			}),
		{ timeout: 180000 },
	)
})
