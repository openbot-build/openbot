import { assert, it } from "@effect/vitest"
import { Effect, Option, Ref, Schema, Stream } from "effect"
import { Prompt, Response, Tool, Toolkit } from "effect/ai"
import { Chat, ChatState, Item, ToolStep, Turn } from "@openbot-build/core"

const position = {
	chat: Chat.Id.make("chat"),
	turn: Turn.Id.make("turn"),
	item: Item.Id.make("item"),
	step: 0,
}
const call = Prompt.makePart("tool-call", {
	id: "call",
	name: "Write",
	params: {},
	providerExecuted: false,
})
const output = Response.makePart("tool-result", {
	id: call.id,
	name: call.name,
	result: "saved",
	encodedResult: "saved",
	providerExecuted: false,
	isFailure: false,
	preliminary: false,
})
const toolkit = Toolkit.make(
	Tool.make("Write", {
		parameters: Schema.Struct({}),
		success: Schema.String,
		needsApproval: true,
	}),
)

for (const removed of [false, true]) {
	it.effect(
		`a saved result is used before current tool checks with removal set to ${removed}`,
		() =>
			Effect.gen(function* () {
				const ready = yield* toolkit.pipe(
					Effect.provide(
						toolkit.toLayer({
							Write: () => Effect.die("A saved call must not run again."),
						}),
					),
				)
				const input = {
					position,
					call,
					prompt: Prompt.empty,
					execute: {
						resume: () => Effect.succeedSome(Stream.succeed(output)),
						run: () => Stream.die("A saved call must not run again."),
					},
				}
				const parts = yield* (
					removed
						? ToolStep.run({ ...input, toolkit: yield* Toolkit.make() })
						: ToolStep.run({ ...input, toolkit: ready })
				).pipe(Stream.runCollect)
				assert.deepStrictEqual(parts, [output])
			}),
	)
}

it.effect("a new call still needs current approval", () =>
	Effect.gen(function* () {
		const ready = yield* toolkit.pipe(
			Effect.provide(
				toolkit.toLayer({
					Write: () => Effect.die("The call has no approval."),
				}),
			),
		)
		const parts = yield* ToolStep.run({
			position,
			call,
			prompt: Prompt.empty,
			toolkit: ready,
			execute: {
				resume: () => Effect.succeedNone,
				run: () => Stream.die("The call has no approval."),
			},
		}).pipe(Stream.runCollect)
		assert.deepStrictEqual(parts, [
			Response.makePart("tool-approval-request", {
				approvalId: '["item","call"]',
				toolCallId: call.id,
			}),
		])
	}),
)

it.effect("a saved call with no current access does not return a result", () =>
	Effect.gen(function* () {
		const failure = yield* ToolStep.run({
			position,
			call,
			prompt: Prompt.empty,
			toolkit: yield* Toolkit.make(),
			execute: {
				resume: () => Effect.fail("access-denied"),
				run: () => Stream.succeed(output),
			},
		}).pipe(Stream.runDrain, Effect.flip)
		assert.equal(failure, "access-denied")
	}),
)

for (const prior of ["allow", "deny", "pending", "result"] as const) {
	for (const dynamic of [false, true]) {
		it.effect(
			`a reused call ID needs its own approval after ${prior} with dynamic check ${dynamic}`,
			() =>
				Effect.gen(function* () {
					const checked = yield* Ref.make(0)
					const tools = Toolkit.make(
						Tool.make("Erase", {
							parameters: Schema.Struct({ note: Schema.String }),
							success: Schema.String,
							needsApproval: dynamic
								? () => Ref.update(checked, (n) => n + 1).pipe(Effect.as(true))
								: true,
						}),
					)
					const ready = yield* tools.pipe(
						Effect.provide(
							tools.toLayer({
								Erase: () => Effect.die("The new call has no approval."),
							}),
						),
					)
					const next = Prompt.makePart("tool-call", {
						id: call.id,
						name: "Erase",
						params: { note: "second" },
						providerExecuted: false,
					})
					const old = Prompt.make([
						{
							role: "assistant",
							content: [
								call,
								Prompt.makePart("tool-approval-request", {
									approvalId: "old",
									toolCallId: call.id,
								}),
							],
						},
					])
					const answered =
						prior === "pending"
							? old
							: Prompt.concat(
									old,
									Prompt.make([
										{
											role: "tool",
											content: [
												Prompt.makePart("tool-approval-response", {
													approvalId: "old",
													approved: prior !== "deny",
												}),
												...(prior === "result"
													? [
															Prompt.makePart("tool-result", {
																id: call.id,
																name: call.name,
																result: "done",
																isFailure: false,
																providerExecuted: false,
															}),
														]
													: []),
											],
										},
									]),
								)
					const prompt = Prompt.concat(
						answered,
						Prompt.make([{ role: "assistant", content: [next] }]),
					)
					assert.isTrue(Option.isNone(ToolStep.decisionFor(prompt, next.id)))
					assert.deepStrictEqual(ChatState.openApprovals(prompt), [])
					const run = (item = position.item) =>
						ToolStep.run({
							position: { ...position, item },
							call: next,
							prompt,
							toolkit: ready,
						}).pipe(Stream.runCollect)
					const parts = yield* run()
					const request = parts[0]
					if (request?.type !== "tool-approval-request")
						return yield* Effect.die("The new call must ask for approval.")
					assert.notEqual(request.approvalId, "old")
					assert.deepStrictEqual(yield* run(), parts)
					assert.notDeepEqual(yield* run(Item.Id.make("other-step")), parts)
					assert.equal(yield* Ref.get(checked), dynamic ? 3 : 0)
					const waiting = Prompt.concat(
						prompt,
						Prompt.make([
							{
								role: "assistant",
								content: [
									Prompt.makePart("tool-approval-request", {
										approvalId: request.approvalId,
										toolCallId: next.id,
									}),
								],
							},
						]),
					)
					assert.deepStrictEqual(ChatState.openApprovals(waiting), [
						{ approvalId: request.approvalId, toolCall: next },
					])
					const late = Prompt.concat(
						waiting,
						Prompt.make([
							{
								role: "tool",
								content: [
									Prompt.makePart("tool-approval-response", {
										approvalId: "old",
										approved: true,
									}),
								],
							},
						]),
					)
					assert.isTrue(Option.isNone(ToolStep.decisionFor(late, next.id)))
					assert.lengthOf(ChatState.openApprovals(late), 1)
					const allowed = Prompt.concat(
						late,
						Prompt.make([
							{
								role: "tool",
								content: [
									Prompt.makePart("tool-approval-response", {
										approvalId: request.approvalId,
										approved: true,
									}),
								],
							},
						]),
					)
					assert.equal(
						Option.getOrThrow(ToolStep.decisionFor(allowed, next.id)).approved,
						true,
					)
					assert.deepStrictEqual(ChatState.openApprovals(allowed), [])
				}),
		)
	}
}

it.effect("an incomplete model call cannot start through recovery", () =>
	Effect.gen(function* () {
		const parts = yield* ToolStep.run({
			position,
			call,
			prompt: Prompt.empty,
			toolkit: yield* Toolkit.make(),
			finishReason: "length",
			execute: {
				resume: () => Effect.die("The model call is not complete"),
				run: () => Stream.die("The model call is not complete"),
			},
		}).pipe(Stream.runCollect)
		assert.equal(parts.length, 1)
		const part = parts[0]!
		assert.equal(part.type, "tool-result")
		if (part.type === "tool-result") assert.isTrue(part.isFailure)
	}),
)
