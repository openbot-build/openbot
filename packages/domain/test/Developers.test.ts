import { assert, it } from "@effect/vitest"
import * as Developers from "../src/Developers.ts"
import * as Execution from "../src/Execution.ts"

const proof: Developers.Proof = {
	id: "proof",
	transition: 2,
	scope: { _tag: "AppCard", cardUrl: "https://app.example.com/card.json" },
	status: "Confirmed",
	confirmedAt: 100,
	validUntil: 2000,
	nextVerificationAt: 1000,
	reason: null,
}
const unavailable: Developers.ProofEvidence = {
	_tag: "Unavailable",
	failure: {
		category: "external",
		errorId: Execution.ErrorId.make("failure"),
	},
}
it("a failed proof check keeps access only until the saved end time", () => {
	const waiting = Developers.assessProof(proof, unavailable, 1500)
	assert.equal(waiting.status, "Unconfirmed")
	assert.equal(waiting.validUntil, 2000)
	assert.equal(waiting.transition, 3)
	const expired = Developers.assessProof(waiting, unavailable, 2000)
	assert.equal(expired.status, "Suspended")
	assert.equal(expired.validUntil, 2000)
	assert.equal(expired.transition, 4)
})
it("missing proof removes access and a later match gives a new term", () => {
	const missing = Developers.assessProof(proof, { _tag: "Missing" }, 1100)
	assert.equal(missing.validUntil, 1100)
	assert.equal(missing.status, "Suspended")
	const confirmed = Developers.assessProof(missing, { _tag: "Matched" }, 1200)
	assert.equal(confirmed.confirmedAt, 1200)
	assert.equal(confirmed.validUntil, 1200 + 7 * 86400000)
	assert.equal(confirmed.transition, 4)
	assert.equal(
		Developers.assessProof(confirmed, { _tag: "Matched" }, 1300).transition,
		4,
	)
})
it("a delayed match cannot bring back a released proof", () => {
	const released: Developers.Proof = { ...proof, status: "Relinquished" }
	assert.strictEqual(
		Developers.assessProof(released, { _tag: "Matched" }, 1200),
		released,
	)
})
