import assert from "node:assert/strict"
import { test } from "node:test"
import { Turn } from "@openbot-build/core"
import { SessionView } from "@openbot-build/api"
import { type Redacted, Schema } from "effect"
import * as BrowserHost from "./BrowserHost.ts"
import { withCookie } from "./Caller.ts"
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

test("the cost of a call is the tokens times the price, rounded up", () => {
	const tokens = tokensOf({
		inputTokens: { total: 1000, uncached: 800, cacheRead: 200 },
		outputTokens: { total: 500, reasoning: 100 },
	} as never)
	assert.deepEqual(tokens, {
		inputUncached: 800,
		inputCacheRead: 200,
		inputCacheWrite: 0,
		outputText: 400,
		outputReasoning: 100,
	})
	assert.equal(costOf(tokens, price), callCost)
	// One token at a price of one micro-USD for one million tokens still costs 1.
	assert.equal(
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

test("a call uses the tier of its input size and the period of its start time", () => {
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
	assert.equal(ratesOf(schedule, input(1000), day).output, 1)
	assert.equal(ratesOf(schedule, input(32_000), day).output, 1)
	assert.equal(ratesOf(schedule, input(32_001), day).output, 2)
	assert.equal(ratesOf(schedule, input(500_000), day).output, 3)
	// 01:00 in Shanghai is in the night period, for any input size.
	const night = Date.parse("2026-10-22T17:00:00Z")
	assert.equal(ratesOf(schedule, input(500_000), night).output, 4)
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
	assert.equal(at("2026-10-23T23:00:00Z"), 2)
	assert.equal(at("2026-10-24T01:59:00Z"), 2)
	assert.equal(at("2026-10-24T02:00:00Z"), 1)
	assert.equal(at("2026-10-23T01:00:00Z"), 1)
	assert.equal(at("2026-10-24T23:00:00Z"), 1)
})

test(
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
				assert.equal(value.status, status, body)
				return body.length === 0 ? undefined : JSON.parse(body)
			}
			const until = async <A>(
				label: string,
				check: () => Promise<A | undefined>,
			): Promise<A> => {
				for (let tries = 0; tries < 600; tries++) {
					const value = await check()
					if (value !== undefined) return value
					await new Promise((resolve) => setTimeout(resolve, 25))
				}
				throw new Error("Timed out: " + label)
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
			assert.equal(platformPrice.timeZone, "UTC")
			assert.deepEqual(platformPrice.periods, [])
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
			assert.equal(unknown._tag, "ModelProviderInvalid")
			const catalog = await json(
				send(alice.session, "/v1/organization/model_catalog"),
			)
			assert.equal(
				catalog.models.find(
					(model: { readonly provider: string }) =>
						model.provider === platformProvider.id,
				)?.price?.tiers[1]?.output,
				price.output,
			)

			const sessionWith = async (provider: string, model: string) => {
				const created = await json(
					send(alice.session, "/v1/sessions", "POST", {
						settings: { model: { _tag: "Config.Selection", provider, model } },
					}),
					201,
				)
				return "/v1/sessions/" + created.session.id
			}
			const read = async (path: string) =>
				Schema.decodeUnknownSync(SessionView)(
					await json(send(alice.session, path)),
				).session
			/** Runs one Turn and gives the status that it ends with. */
			const turn = async (path: string) => {
				const current = await read(path)
				// Work after a Turn, such as Session memory, can still run. Then start again.
				await until("the Turn starts", async () => {
					const latest = await read(path)
					const started = await send(alice.session, path + "/turns", "POST", {
						expected: latest.revision,
						input: "Say done",
					})
					if (started.status === 409) return undefined
					assert.equal(started.status, 202, await started.text())
					return true
				})
				return until("the Turn ends", async () => {
					const session = await read(path)
					const last = session.turns.at(-1)
					return session.turns.length > current.turns.length &&
						last !== undefined &&
						Turn.isTerminal(last.status)
						? last.status._tag
						: undefined
				})
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
			const platformSession = await sessionWith(platformProvider.id, "large")
			assert.equal(await turn(platformSession), "Completed")
			const [first] = await turnEvents()
			assert.ok(first !== undefined)
			assert.equal(first["sessionId"], platformSession.split("/").at(-1))
			assert.equal(first["userId"], alice.identity.userId)
			assert.equal(typeof first["turnId"], "string")
			assert.equal(typeof first["botId"], "string")
			assert.equal(first["providerOwner"], "platform")
			assert.equal(first["inputUncached"], 800)
			assert.equal(first["inputCacheRead"], 200)
			assert.equal(first["outputText"], 500)
			assert.equal(first["costMicros"], callCost)
			assert.equal(first["priced"], true)
			assert.equal(first["charged"], false)
			// The Session memory call of the same Turn has its own source.
			const memory = await until("the memory call", async () =>
				(await events()).find((event) => event["source"] === "session_memory"),
			)
			assert.equal(memory["turnId"], first["turnId"])
			assert.equal(memory["userId"], alice.identity.userId)

			const byMember = await json(
				send(alice.session, "/v1/organization/usage?groupBy=member"),
			)
			assert.equal(byMember.groupBy, "member")
			const aliceTotal = byMember.items.find(
				(item: { readonly key: string | null }) =>
					item.key === alice.identity.userId,
			)
			assert.ok(aliceTotal.costMicros >= callCost)
			assert.equal(
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
			assert.equal((await json(send(root.session, credits))).enabled, false)
			assert.equal((await send(alice.session, credits)).status, 403)
			await json(send(root.session, credits, "PATCH", { enabled: true }))
			const before = (await turnEvents()).length
			assert.notEqual(await turn(platformSession), "Completed")
			assert.equal((await turnEvents()).length, before)
			const grant = await json(
				send(root.session, credits + "/grants", "POST", {
					amountMicros: 10_000,
					note: "Trial credits",
				}),
				201,
			)
			assert.equal(grant.amountMicros, 10_000)
			assert.equal(await turn(platformSession), "Completed")
			// Each Turn also learns Session memory with the same model, so it makes more than one call.
			const charged = (await events())
				.filter((event) => event["charged"] === true)
				.reduce((sum, event) => sum + Number(event["costMicros"]), 0)
			assert.ok(charged >= callCost)
			const paid = await json(send(alice.session, "/v1/organization/credits"))
			assert.equal(paid.enabled, true)
			assert.equal(paid.balanceMicros, 10_000 - charged)
			assert.equal((await turnEvents())[0]?.["charged"], true)

			// The own key of the organization never takes credits.
			const ownSession = await sessionWith(ownProvider.id, "small")
			assert.equal(await turn(ownSession), "Completed")
			const own = (await turnEvents())[0]
			assert.equal(own?.["providerOwner"], "organization")
			assert.equal(own?.["charged"], false)
			assert.equal(own?.["costMicros"], callCost)
			assert.equal(
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
			assert.equal(hard.exceeded, true)
			assert.equal(hard.scopeId, organizationId)
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
			assert.equal(soft.exceeded, true)
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
			assert.equal(twice._tag, "BudgetConflict")
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
			assert.equal(stranger._tag, "BudgetInvalid")
			assert.notEqual(await turn(ownSession), "Completed")
			const raised = await json(
				send(alice.session, "/v1/organization/budgets/" + hard.id, "PATCH", {
					expectedVersion: hard.version,
					limitMicros: 1_000_000,
				}),
			)
			assert.equal(raised.exceeded, false)
			assert.equal(await turn(ownSession), "Completed")
			await json(
				send(alice.session, "/v1/organization/budgets/" + hard.id, "DELETE"),
				204,
			)
			const listed = await json(send(alice.session, "/v1/organization/budgets"))
			assert.deepEqual(
				listed.items.map((budget: { readonly id: string }) => budget.id),
				[soft.id],
			)

			// Members cannot read usage or change budgets.
			assert.equal(
				(await send(bob.session, "/v1/organization/usage")).status,
				403,
			)
			assert.equal(
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
			assert.deepEqual(settings.rateLimit, { requestsPerMinute: null })
			const limited = await json(
				send(root.session, "/v1/platform/settings", "PATCH", {
					expectedVersion: settings.version,
					rateLimit: { requestsPerMinute: 3 },
				}),
			)
			const statuses: Array<number> = []
			for (let index = 0; index < 10; index++)
				statuses.push(
					(await send(bob.session as Redacted.Redacted<string>, "/v1/sessions"))
						.status,
				)
			// At most two windows of one minute, so at most six requests pass.
			assert.ok(statuses.filter((status) => status === 429).length >= 4)
			const refused = await send(bob.session, "/v1/sessions")
			if (refused.status === 429) {
				const body = await refused.json()
				assert.equal(body._tag, "RateLimited")
				assert.ok(body.retryAfterSeconds >= 1 && body.retryAfterSeconds <= 60)
			}
			await json(
				send(root.session, "/v1/platform/settings", "PATCH", {
					expectedVersion: limited.version,
					rateLimit: { requestsPerMinute: null },
				}),
			)
			assert.equal((await send(bob.session, "/v1/sessions")).status, 200)

			// Token rates slow the work down. They never make it fail.
			const platform = await json(send(root.session, "/v1/platform/settings"))
			assert.deepEqual(platform.tokenRate, {
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
			assert.equal(await turn(ownSession), "Completed")
			assert.equal(await turn(ownSession), "Completed")
		} finally {
			await host.close()
		}
	},
)
