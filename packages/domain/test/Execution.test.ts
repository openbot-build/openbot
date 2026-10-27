import { assert, describe, it } from "@effect/vitest"
import { Execution } from "../src/index.ts"

describe("Execution state", () => {
	it("a cancel request waits for the owner to stop", () => {
		assert.isTrue(Execution.canTransition("running", "cancelling"))
		assert.isFalse(Execution.canTransition("running", "cancelled"))
		assert.isFalse(Execution.canTransition("cancelling", "completed"))
		assert.isTrue(Execution.canTransition("cancelling", "cancelled"))
	})
	it("an unknown result can wait for a decision", () => {
		assert.isFalse(Execution.isTerminal("outcome_unknown"))
		assert.isTrue(Execution.canTransition("running", "outcome_unknown"))
		assert.isTrue(Execution.canTransition("outcome_unknown", "running"))
		assert.isFalse(Execution.canTransition("outcome_unknown", "completed"))
	})
	it("an ended execution cannot start again", () => {
		for (const state of [
			"completed",
			"failed",
			"cancelled",
			"interrupted",
		] as const) {
			assert.isTrue(Execution.isTerminal(state))
			for (const next of Execution.Status.literals)
				assert.isFalse(Execution.canTransition(state, next))
		}
	})
})
