import { assert, it } from "@effect/vitest"
import { Turn } from "@openbot-build/core"
import { type Redacted } from "effect"
import * as BrowserHost from "./BrowserHost.ts"
import { withCookie } from "./Caller.ts"
import { bot, message, settled, type Send } from "./Messages.ts"
import { costOf, ratesOf, tokensOf } from "../src/billing/Billing.ts"

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

/** A model API in the OpenAI chat format. It answers every call with the same text and usage. */
const providerFetch: typeof fetch = async (input, init) => {
	const request = input instanceof Request ? input : new Request(input, init)
	const body = (await request.json()) as { readonly stream?: boolean }
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
	const events = [
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
	]
	return new Response(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
			"data: [DONE]\n\n",
		{ headers: { "content-type": "text/event-stream" } },
	)
}

it("the cost of a call is the tokens times the price, rounded up", () => {
	const tokens = tokensOf({
		inputTokens: { total: 1000, uncached: 800, cacheRead: 200 },
		outputTokens: { total: 500, reasoning: 100 },
	} as never)
	assert.deepStrictEqual(tokens, {
		inputUncached: 800,
		inputCacheRead: 200,
		inputCacheWrite: 0,
		outputText: 400,
		outputReasoning: 100,
	})
	assert.strictEqual(costOf(tokens, price), callCost)
	// One token at a price of one micro-USD for one million tokens still costs 1.
	assert.strictEqual(
		costOf(
			{
				...tokens,
				inputUncached: 1,
				inputCacheRead: 0,
				outputText: 0,
				outputReasoning: 0,
			},
			{ ...price, inputUncached: 1 },
		),
		1,
	)
})

it("a call uses the tier of its input size and the period of its start time", () => {
	const rates = (output: number) => ({ ...price, output })
	const schedule = {
		timeZone: "Asia/Shanghai",
		tiers: [
			{ upToInputTokens: 32_000, ...rates(1) },
			{ upToInputTokens: 128_000, ...rates(2) },
			{ upToInputTokens: null, ...rates(3) },
		],
		periods: [
			{
				name: "night",
				windows: [{ start: "00:30", end: "08:30" }],
				tiers: [{ upToInputTokens: null, ...rates(4) }],
			},
		],
	}
	const input = (inputUncached: number) => ({
		inputUncached,
		inputCacheRead: 0,
		inputCacheWrite: 0,
		outputText: 0,
		outputReasoning: 0,
	})
	// 10:00 in Shanghai on Friday, 23 October 2026.
	const day = Date.parse("2026-10-23T02:00:00Z")
	assert.strictEqual(ratesOf(schedule, input(1000), day).output, 1)
	assert.strictEqual(ratesOf(schedule, input(32_000), day).output, 1)
	assert.strictEqual(ratesOf(schedule, input(32_001), day).output, 2)
	assert.strictEqual(ratesOf(schedule, input(500_000), day).output, 3)
	// 01:00 in Shanghai is in the night period, for any input size.
	const night = Date.parse("2026-10-22T17:00:00Z")
	assert.strictEqual(ratesOf(schedule, input(500_000), night).output, 4)
	// A window past midnight belongs to the day that it starts.
	const friday = {
		timeZone: "UTC",
		tiers: [{ upToInputTokens: null, ...rates(1) }],
		periods: [
			{
				name: "friday night",
				windows: [{ start: "22:00", end: "02:00", days: ["fri" as const] }],
				tiers: [{ upToInputTokens: null, ...rates(2) }],
			},
		],
	}
	const at = (time: string) =>
		ratesOf(friday, input(1), Date.parse(time)).output
	assert.strictEqual(at("2026-10-23T23:00:00Z"), 2)
	assert.strictEqual(at("2026-10-24T01:59:00Z"), 2)
	assert.strictEqual(at("2026-10-24T02:00:00Z"), 1)
	assert.strictEqual(at("2026-10-23T01:00:00Z"), 1)
	assert.strictEqual(at("2026-10-24T23:00:00Z"), 1)
})

it(
	"model calls are metered, priced, limited by budgets and paid with credits",
	{ timeout: 180000 },
	async () => {
		const host = await BrowserHost.start({
			publicOrigin,
			platformAdmins: ["root@example.com"],
			registryModels: true,
			platformFetch: providerFetch,
			bots: { memory: false },
		})
		try {
			const send = withCookie({ address: host.address, publicOrigin })
			const json = async (response: Promise<Response>, status = 200) => {
				const value = await response
				const body = await value.text()
				assert.strictEqual(value.status, status, body)
				return body.length === 0 ? undefined : JSON.parse(body)
			}

			// Alice signs in first, so the others join her organization.
			const alice = await host.login("alice")
			const bob = await host.login("bob")
			const root = await host.login("root")
			await host.defaultBot(alice.session)
			const organizationId = alice.identity.organizationId

			// The platform shares a model that it pays for.
			await json(
				send(root.session, "/v1/platform/models", "POST", {
					id: "large",
					name: "Large",
					reasoningEfforts: [],
					serviceTiers: [],
					availability: { _tag: "All" },
				}),
			)
			const platformProvider = await json(
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
			await json(
				send(alice.session, "/v1/organization/models", "POST", {
					id: "small",
					name: "Small",
					reasoningEfforts: [],
					serviceTiers: [],
				}),
			)
			const ownProvider = await json(
				send(alice.session, "/v1/organization/model_providers", "POST", {
					kind: "openai-compat",
					name: "Own key",
					endpoint: "https://own-models.example.com/v1",
					apiKey: "sk-own-0123456789",
					models: [{ model: "small", modelOwner: "organization" }],
				}),
			)

			// Prices. A provider can only price the models that it offers.
			const platformPrice = await json(
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
			await json(
				send(
					alice.session,
					`/v1/organization/model_providers/${ownProvider.id}/prices`,
					"PUT",
					{ model: "small", ...flat },
				),
			)
			const unknown = await json(
				send(
					alice.session,
					`/v1/organization/model_providers/${ownProvider.id}/prices`,
					"PUT",
					{ model: "large", ...flat },
				),
				400,
			)
			assert.strictEqual(unknown._tag, "ModelProviderInvalid")
			const catalog = await json(
				send(alice.session, "/v1/organization/model_catalog"),
			)
			assert.strictEqual(
				catalog.models.find(
					(model: { readonly provider: string }) =>
						model.provider === platformProvider.id,
				)?.price?.tiers[1]?.output,
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
			const turn = async (botId: string) => {
				const receipt = await message(asAlice, botId, "Say done")
				assert.strictEqual(receipt.delivery, "started")
				assert.ok(receipt.turn !== null)
				await settled(asAlice, receipt.chat)
				const read = await json(
					send(
						alice.session,
						`/v1/chats/${receipt.chat}/turns/${receipt.turn}`,
					),
				)
				assert.ok(Turn.isTerminal(read.turn.status))
				return read.turn.status._tag as string
			}
			const events = async () =>
				(
					await json(
						send(alice.session, "/v1/organization/usage/events?limit=200"),
					)
				).items as ReadonlyArray<Record<string, unknown>>
			const turnEvents = async () =>
				(await events()).filter((event) => event["source"] === "turn")

			// A Turn on the platform model is metered.
			const platformBot = await botWith(platformProvider.id, "large")
			assert.strictEqual(await turn(platformBot), "Completed")
			const [first] = await turnEvents()
			assert.ok(first !== undefined)
			const platformChat = await json(
				send(alice.session, `/v1/chats?bot=${platformBot}`),
			)
			assert.strictEqual(platformChat.length, 1)
			assert.strictEqual(first["chatId"], platformChat[0].chat.id)
			assert.strictEqual(first["userId"], alice.identity.userId)
			assert.strictEqual(typeof first["turnId"], "string")
			assert.strictEqual(typeof first["botId"], "string")
			assert.strictEqual(first["providerOwner"], "platform")
			assert.strictEqual(first["inputUncached"], 800)
			assert.strictEqual(first["inputCacheRead"], 200)
			assert.strictEqual(first["outputText"], 500)
			assert.strictEqual(first["costMicros"], callCost)
			assert.strictEqual(first["priced"], true)
			assert.strictEqual(first["charged"], false)

			const byMember = await json(
				send(alice.session, "/v1/organization/usage?groupBy=member"),
			)
			assert.strictEqual(byMember.groupBy, "member")
			const aliceTotal = byMember.items.find(
				(item: { readonly key: string | null }) =>
					item.key === alice.identity.userId,
			)
			assert.ok(aliceTotal.costMicros >= callCost)
			assert.strictEqual(
				(
					await json(
						send(alice.session, "/v1/organization/usage?from=yesterday"),
						400,
					)
				)._tag,
				"UsageQueryInvalid",
			)

			// Credits are off until a platform admin turns them on.
			const credits = `/v1/platform/organizations/${organizationId}/credits`
			assert.strictEqual(
				(await json(send(root.session, credits))).enabled,
				false,
			)
			assert.strictEqual((await send(alice.session, credits)).status, 403)
			await json(send(root.session, credits, "PATCH", { enabled: true }))
			const before = (await turnEvents()).length
			assert.notStrictEqual(await turn(platformBot), "Completed")
			assert.strictEqual((await turnEvents()).length, before)
			const grant = await json(
				send(root.session, credits + "/grants", "POST", {
					amountMicros: 10_000,
					note: "Trial credits",
				}),
				201,
			)
			assert.strictEqual(grant.amountMicros, 10_000)
			assert.strictEqual(await turn(platformBot), "Completed")
			const charged = (await events())
				.filter((event) => event["charged"] === true)
				.reduce((sum, event) => sum + Number(event["costMicros"]), 0)
			assert.ok(charged >= callCost)
			const paid = await json(send(alice.session, "/v1/organization/credits"))
			assert.strictEqual(paid.enabled, true)
			assert.strictEqual(paid.balanceMicros, 10_000 - charged)
			assert.strictEqual((await turnEvents())[0]?.["charged"], true)

			// The own key of the organization never takes credits.
			const ownBot = await botWith(ownProvider.id, "small")
			assert.strictEqual(await turn(ownBot), "Completed")
			const own = (await turnEvents())[0]
			assert.strictEqual(own?.["providerOwner"], "organization")
			assert.strictEqual(own?.["charged"], false)
			assert.strictEqual(own?.["costMicros"], callCost)
			assert.strictEqual(
				(await json(send(alice.session, "/v1/organization/credits")))
					.balanceMicros,
				10_000 - charged,
			)

			// A spent hard budget stops calls on any key. A soft budget only says so.
			const hard = await json(
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
			const soft = await json(
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
			const twice = await json(
				send(alice.session, "/v1/organization/budgets", "POST", {
					scope: "organization",
					period: "day",
					limitMicros: 5,
					mode: "soft",
				}),
				409,
			)
			assert.strictEqual(twice._tag, "BudgetConflict")
			const stranger = await json(
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
			assert.notStrictEqual(await turn(ownBot), "Completed")
			const raised = await json(
				send(alice.session, "/v1/organization/budgets/" + hard.id, "PATCH", {
					expectedVersion: hard.version,
					limitMicros: 1_000_000,
				}),
			)
			assert.strictEqual(raised.exceeded, false)
			assert.strictEqual(await turn(ownBot), "Completed")
			await json(
				send(alice.session, "/v1/organization/budgets/" + hard.id, "DELETE"),
				204,
			)
			const listed = await json(send(alice.session, "/v1/organization/budgets"))
			assert.deepStrictEqual(
				listed.items.map((budget: { readonly id: string }) => budget.id),
				[soft.id],
			)

			// Members cannot read usage or change budgets.
			assert.strictEqual(
				(await send(bob.session, "/v1/organization/usage")).status,
				403,
			)
			assert.strictEqual(
				(
					await send(bob.session, "/v1/organization/budgets", "POST", {
						scope: "organization",
						period: "month",
						limitMicros: 5,
						mode: "hard",
					})
				).status,
				403,
			)

			// The rate limit counts the requests of each caller in each minute.
			const settings = await json(send(root.session, "/v1/platform/settings"))
			assert.deepStrictEqual(settings.rateLimit, { requestsPerMinute: null })
			const limited = await json(
				send(root.session, "/v1/platform/settings", "PATCH", {
					expectedVersion: settings.version,
					rateLimit: { requestsPerMinute: 3 },
				}),
			)
			const statuses: Array<number> = []
			for (let index = 0; index < 10; index++)
				statuses.push(
					(await send(bob.session as Redacted.Redacted<string>, "/v1/chats"))
						.status,
				)
			// At most two windows of one minute, so at most six requests pass.
			assert.ok(statuses.filter((status) => status === 429).length >= 4)
			const refused = await send(bob.session, "/v1/chats")
			if (refused.status === 429) {
				const body = await refused.json()
				assert.strictEqual(body._tag, "RateLimited")
				assert.ok(body.retryAfterSeconds >= 1 && body.retryAfterSeconds <= 60)
			}
			await json(
				send(root.session, "/v1/platform/settings", "PATCH", {
					expectedVersion: limited.version,
					rateLimit: { requestsPerMinute: null },
				}),
			)
			assert.strictEqual((await send(bob.session, "/v1/chats")).status, 200)

			// Token rates slow the work down. They never make it fail.
			const platform = await json(send(root.session, "/v1/platform/settings"))
			assert.deepStrictEqual(platform.tokenRate, {
				organization: null,
				member: null,
				bot: null,
				token: null,
			})
			await json(
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
			const organizationSettings = await json(
				send(alice.session, "/v1/organization/settings"),
			)
			await json(
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
			assert.strictEqual(await turn(ownBot), "Completed")
			assert.strictEqual(await turn(ownBot), "Completed")
		} finally {
			await host.close()
		}
	},
)
