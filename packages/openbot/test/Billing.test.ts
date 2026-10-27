import { assert, it } from "@effect/vitest"
import { BillingApi } from "@openbot-build/api"
import { Response as ModelResponse } from "effect/ai"
import { costOf, ratesOf, tokensOf } from "../src/billing/Billing.ts"

/** Micro-USD for one million tokens. */
const price = {
	inputUncached: 2_000_000,
	inputCacheRead: 500_000,
	inputCacheWrite: 0,
	output: 8_000_000,
	outputReasoning: null,
}
/** 800 uncached, 200 cached and 500 output tokens: 1600 + 100 + 4000. */
const callCost = 5700

it("the cost of a call is the tokens times the price, rounded up", () => {
	const tokens = tokensOf(
		ModelResponse.Usage.make({
			inputTokens: { total: 1000, uncached: 800, cacheRead: 200 },
			outputTokens: { total: 500, reasoning: 100 },
		}),
	)
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
	const schedule: BillingApi.PriceSchedule = {
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
	const friday: BillingApi.PriceSchedule = {
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
