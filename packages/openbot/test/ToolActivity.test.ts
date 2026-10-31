import { assert, describe, it } from "@effect/vitest"
import { Execution } from "@openbot-build/domain"
import { Option, Schema } from "effect"
import * as Activity from "../src/execution/ToolActivity.ts"

const record: Execution.Record = {
	id: Execution.Id.make("execution"),
	resource: { kind: "Turn", id: "turn" },
	status: "running",
	sequence: 4,
	createdAt: 0,
	updatedAt: 1,
	failure: null,
}
const call: Execution.Call = {
	id: Execution.CallId.make("call-record"),
	executionId: record.id,
	step: "tool:4:itemcall",
	attempt: 0,
	status: "sending",
	retry: "never",
	result: null,
	input: {
		chat: "chat",
		turn: "turn",
		item: "item",
		call: "call",
		name: "openbot_computer_exec",
		params: { computer: "computer", command: "private" },
		inputState: { secret: "private" },
		parameters: { private: true },
	},
}
const tool: Execution.ToolActivity = {
	chatId: "chat",
	turnId: "turn",
	itemId: "item",
	callId: "call",
	name: "openbot_computer_exec",
	computerId: "computer",
}
const scope = {
	resourceKind: "Turn",
	resourceId: "turn",
	contextKind: "Chat",
	contextId: "chat",
}

describe("safe foreground tool activity", () => {
	it("publishes only identity and an allowlisted computer reference", () => {
		assert.deepEqual(Activity.of(call), Option.some(tool))
		assert.deepEqual(Activity.started(call, scope), {
			_tag: "StepStarted",
			step: call.step,
			attempt: 0,
			tool,
		})
		assert.isTrue(Schema.is(Execution.EventBody)(Activity.started(call, scope)))
		assert.deepEqual(Activity.started(call, { ...scope, contextId: "other" }), {
			_tag: "StepStarted",
			step: call.step,
			attempt: 0,
		})
		assert.deepEqual(
			Activity.of({
				...call,
				input: {
					chat: "chat",
					turn: "turn",
					item: "item",
					call: "call",
					name: "unrelated_tool",
					params: { computer: "private", command: "private" },
				},
			}),
			Option.some({
				chatId: "chat",
				turnId: "turn",
				itemId: "item",
				callId: "call",
				name: "unrelated_tool",
			}),
		)
	})
	it("does not interpret model input or malformed tool positions as activity", () => {
		assert.deepEqual(
			Activity.of({ ...call, step: "model:item" }),
			Option.none(),
		)
		assert.deepEqual(
			Activity.of({ ...call, step: "tool:5:itemcall" }),
			Option.none(),
		)
		assert.deepEqual(
			Activity.of({ ...call, input: { name: "tool" } }),
			Option.none(),
		)
	})
	it("reports intended, sending and waiting states without claiming a send early", () => {
		for (const [status, expected] of [
			["intended", "queued"],
			["sending", "running"],
			["outcome_unknown", "outcome_unknown"],
		] as const) {
			assert.equal(
				Activity.active(record, [{ ...call, status }], "chat", "turn")[0]
					?.status,
				expected,
			)
		}
		for (const status of ["waiting", "cancelling", "outcome_unknown"] as const)
			assert.equal(
				Activity.active({ ...record, status }, [call], "chat", "turn")[0]
					?.status,
				status,
			)
	})
	it("clears completed and terminal work and rejects another Chat or Turn", () => {
		assert.deepEqual(
			Activity.active(
				record,
				[{ ...call, status: "completed" }],
				"chat",
				"turn",
			),
			[],
		)
		for (const status of [
			"completed",
			"failed",
			"cancelled",
			"interrupted",
		] as const)
			assert.deepEqual(
				Activity.active({ ...record, status }, [call], "chat", "turn"),
				[],
			)
		assert.deepEqual(Activity.active(record, [call], "other-chat", "turn"), [])
		assert.deepEqual(Activity.active(record, [call], "chat", "other-turn"), [])
		assert.deepEqual(
			Activity.active(
				record,
				[{ ...call, executionId: Execution.Id.make("other") }],
				"chat",
				"turn",
			),
			[],
		)
	})
	it("a late old attempt cannot restore running state after the latest one completed", () => {
		const next = { ...call, id: Execution.CallId.make("next"), attempt: 1 }
		assert.deepEqual(Activity.active(record, [call, next], "chat", "turn"), [
			{
				executionId: record.id,
				step: call.step,
				attempt: 1,
				tool,
				status: "running",
			},
		])
		assert.deepEqual(
			Activity.active(
				record,
				[call, { ...next, status: "completed" }],
				"chat",
				"turn",
			),
			[],
		)
	})
})
