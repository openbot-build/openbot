import { ChatModelInvalid } from "@openbot-build/domain/Chats"
import { assert, it } from "@effect/vitest"
import { Authorizer } from "@nmnmcc/ability"
import { Bots, Execution } from "@openbot-build/domain"
import { Cause, Schema } from "effect"
import { category } from "@openbot-build/server-kernel/Records"

class Limited extends Schema.TaggedError<
	Limited,
	{ readonly brand: unique symbol }
>()("TestLimited", {}, Execution.category("limited")) {}

/** An error that reads its category from its own field. */
class Chosen extends Schema.TaggedError<
	Chosen,
	{ readonly brand: unique symbol }
>()(
	"TestChosen",
	{ chosen: Execution.Category },
	Execution.category(
		(error: { readonly chosen: Execution.Category }) => error.chosen,
	),
) {}

class Plain extends Schema.TaggedError<
	Plain,
	{ readonly brand: unique symbol }
>()("TestPlain", {}) {}

const errorId = Execution.ErrorId.make("019a0000-0000-7000-8000-000000000000")

it("an error class gives its category through its annotation", () => {
	assert.strictEqual(category(Cause.fail(Limited.make({}))), "limited")
	assert.strictEqual(
		category(Cause.fail(Execution.Forbidden.make({}))),
		"forbidden",
	)
	assert.strictEqual(
		category(
			Cause.fail(Execution.NotFound.make({ id: Execution.Id.make("e") })),
		),
		"not_found",
	)
	assert.strictEqual(
		category(Cause.fail(Execution.KeyConflict.make({}))),
		"conflict",
	)
	assert.strictEqual(
		category(Cause.fail(Bots.BotNotFound.make({ bot: "bot" }))),
		"not_found",
	)
	assert.strictEqual(
		category(
			Cause.fail(
				ChatModelInvalid.make({
					reason: "model-not-found",
					message: "No model.",
				}),
			),
		),
		"invalid",
	)
})

it("an annotation can read the category from the error", () => {
	assert.strictEqual(
		category(Cause.fail(Chosen.make({ chosen: "conflict" }))),
		"conflict",
	)
	assert.strictEqual(
		category(Cause.fail(Chosen.make({ chosen: "limited" }))),
		"limited",
	)
})

it("a saved failure keeps its category", () => {
	assert.strictEqual(
		category(Cause.fail({ errorId, category: "limited" })),
		"limited",
	)
})

it("the errors of the authorization library are forbidden", () => {
	assert.strictEqual(
		category(
			Cause.fail(Authorizer.Forbidden.make({ action: "read", kind: "chat" })),
		),
		"forbidden",
	)
})

it("every other cause is unavailable", () => {
	assert.strictEqual(category(Cause.fail(Plain.make({}))), "unavailable")
	assert.strictEqual(category(Cause.fail("text")), "unavailable")
	assert.strictEqual(category(Cause.die(Limited.make({}))), "unavailable")
	assert.strictEqual(
		category(
			Cause.combine(
				Cause.fail(Limited.make({})),
				Cause.fail(Execution.Forbidden.make({})),
			),
		),
		"unavailable",
	)
})
