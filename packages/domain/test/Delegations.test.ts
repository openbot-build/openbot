import { assert, it } from "@effect/vitest"
import { Option } from "effect"
import { Delegations } from "../src/index.ts"

it("renewed limits use the saved window and keep time first", () => {
	const window = { timeMs: 2000, steps: 3, costMicros: 100 }
	const limits = { timeMs: 1000, steps: 2, budgetMicros: 50 }
	assert.isTrue(Option.isNone(Delegations.reached(limits, window, window)))
	assert.deepEqual(
		Delegations.reached(
			limits,
			{ timeMs: 2999, steps: 4, costMicros: 150 },
			window,
		),
		Option.some("budget"),
	)
	assert.deepEqual(
		Delegations.reached(
			limits,
			{ timeMs: 2999, steps: 5, costMicros: 150 },
			window,
		),
		Option.some("steps"),
	)
	assert.deepEqual(
		Delegations.reached(
			limits,
			{ timeMs: 3000, steps: 5, costMicros: 150 },
			window,
		),
		Option.some("time"),
	)
})

it("a child's clock counts the overlap of its own and ancestor running periods", () => {
	const own = [{ start: 10, end: null }]
	const parent = [
		{ start: 0, end: 30 },
		{ start: 60, end: null },
	]
	const root = [
		{ start: 0, end: 20 },
		{ start: 40, end: 70 },
	]
	assert.equal(Delegations.runningTime(own, [parent, root], 100), 20)
	assert.equal(Delegations.runningTime(own, [parent], 100), 60)
	// Resuming an ancestor adds running time, without resetting the child's earlier use.
	assert.equal(
		Delegations.runningTime(
			own,
			[
				[
					{ start: 0, end: 30 },
					{ start: 60, end: 80 },
				],
			],
			100,
		),
		40,
	)
	assert.equal(Delegations.runningTime(own, [[]], 100), 0)
	assert.equal(Delegations.runningTime([], [], 100), 0)
})

it("an owner's pause and final close freeze its clock", () => {
	const periods = [
		{ start: 10, end: 30 },
		{ start: 60, end: 80 },
	]
	assert.equal(Delegations.runningTime(periods, [], 25), 15)
	assert.equal(Delegations.runningTime(periods, [], 100), 40)
	assert.equal(Delegations.runningTime(periods, [], 1000), 40)
})
