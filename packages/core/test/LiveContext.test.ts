import { assert, it } from "@effect/vitest"
import { Live } from "@openbot-build/core"
import { Array as Arr, Effect } from "effect"
import { Prompt } from "effect/ai"

const capabilities: Live.Capabilities = {
	audio: { input: [], output: [] },
	turnDetection: [],
	inputTranscription: true,
	tools: true,
	interruption: true,
	truncate: true,
	inputs: { text: true, image: true, imageMediaTypes: ["image/png"] },
	voices: [],
}

it.effect("reused tool IDs keep separate call and result pairs", () =>
	Effect.gen(function* () {
		const prompt = Prompt.make(
			Arr.flatMap(["call", "call_1", "call"], (id) => [
				Prompt.assistantMessage({
					content: [
						Prompt.toolCallPart({
							id,
							name: "Read",
							params: {},
							providerExecuted: false,
						}),
					],
				}),
				Prompt.toolMessage({
					content: [
						Prompt.toolResultPart({
							id,
							name: "Read",
							result: "saved",
							isFailure: false,
							providerExecuted: false,
						}),
					],
				}),
			]),
		)
		const context = yield* Live.contextOf(prompt, capabilities)
		assert.deepStrictEqual(
			Arr.flatMap(context, (item) =>
				item.type === "message" ? [] : [item.callId],
			),
			["call", "call", "call_1", "call_1", "call_2", "call_2"],
		)
	}),
)

it.effect(
	"portable Live context keeps text, images and completed tool work",
	() =>
		Effect.gen(function* () {
			const prompt = Prompt.make([
				{
					role: "user",
					content: [
						Prompt.textPart({ text: "Read this." }),
						Prompt.filePart({
							mediaType: "image/png",
							data: new Uint8Array([1, 2, 3]),
						}),
					],
				},
				{
					role: "assistant",
					content: [
						Prompt.toolCallPart({
							id: "call_1",
							name: "Read",
							params: { page: 1 },
							providerExecuted: false,
						}),
					],
				},
				{
					role: "tool",
					content: [
						Prompt.toolResultPart({
							id: "call_1",
							name: "Read",
							result: "A tree",
							isFailure: false,
							providerExecuted: false,
						}),
					],
				},
				{ role: "assistant", content: "It is a tree." },
			])
			const context = yield* Live.contextOf(prompt, capabilities)
			assert.deepStrictEqual(context, [
				{
					type: "message",
					role: "user",
					content: [{ type: "text", text: "Read this." }],
				},
				{
					type: "message",
					role: "user",
					content: [{ type: "image", mediaType: "image/png", data: "AQID" }],
				},
				{
					type: "call",
					callId: "call_1",
					name: "Read",
					arguments: '{"page":1}',
				},
				{ type: "result", callId: "call_1", output: '"A tree"' },
				{
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "It is a tree." }],
				},
			])
		}),
)

it.effect("context does not drop old messages at a fixed item limit", () =>
	Effect.gen(function* () {
		const prompt = Prompt.make(
			Array.from({ length: 80 }, (_, index) => ({
				role: "user" as const,
				content: `Message ${index}`,
			})),
		)
		const context = yield* Live.contextOf(prompt, capabilities)
		assert.strictEqual(context.length, 80)
		assert.deepStrictEqual(context[0], {
			type: "message",
			role: "user",
			content: [{ type: "text", text: "Message 0" }],
		})
	}),
)

it.effect(
	"unsupported files and unresolved tools fail instead of losing context",
	() =>
		Effect.gen(function* () {
			const prompts = [
				Prompt.make([
					{
						role: "user",
						content: [
							Prompt.filePart({
								mediaType: "application/pdf",
								data: new Uint8Array([1]),
							}),
						],
					},
				]),
				Prompt.make([
					{
						role: "user",
						content: [
							Prompt.filePart({
								mediaType: "image/png",
								data: new URL("https://example.com/private.png"),
							}),
						],
					},
				]),
				Prompt.make([
					{
						role: "assistant",
						content: [
							Prompt.toolCallPart({
								id: "pending",
								name: "Write",
								params: {},
								providerExecuted: false,
							}),
						],
					},
				]),
				Prompt.make([
					{
						role: "tool",
						content: [
							Prompt.toolResultPart({
								id: "missing",
								name: "Write",
								result: "ok",
								isFailure: false,
								providerExecuted: false,
							}),
						],
					},
				]),
			]
			for (const prompt of prompts) {
				const error = yield* Live.validateContext(prompt, capabilities).pipe(
					Effect.flip,
				)
				assert.strictEqual(error.reason, "unsupported")
			}
			const image = Prompt.make([
				{
					role: "user",
					content: [Prompt.filePart({ mediaType: "image/png", data: "AQID" })],
				},
			])
			const error = yield* Live.validateContext(image, {
				...capabilities,
				inputs: { text: true, image: false },
			}).pipe(Effect.flip)
			assert.strictEqual(error.reason, "unsupported")
			for (const inputs of [
				{ text: true, image: true },
				{ text: true, image: true, imageMediaTypes: ["image/jpeg"] },
			]) {
				const unsupported = yield* Live.validateContext(image, {
					...capabilities,
					inputs,
				}).pipe(Effect.flip)
				assert.strictEqual(unsupported.reason, "unsupported")
			}
		}),
)

it.effect(
	"approval records remain read-only history beside their tool result",
	() =>
		Effect.gen(function* () {
			const prompt = Prompt.make([
				{
					role: "assistant",
					content: [
						Prompt.toolCallPart({
							id: "write",
							name: "Write",
							params: {},
							providerExecuted: false,
						}),
						Prompt.toolApprovalRequestPart({
							approvalId: "approval",
							toolCallId: "write",
						}),
					],
				},
				{
					role: "tool",
					content: [
						Prompt.toolApprovalResponsePart({
							approvalId: "approval",
							approved: true,
						}),
						Prompt.toolResultPart({
							id: "write",
							name: "Write",
							result: "saved",
							isFailure: false,
							providerExecuted: false,
						}),
					],
				},
			])
			const context = yield* Live.contextOf(prompt, capabilities)
			assert.deepStrictEqual(
				Arr.map(context, (item) => item.type),
				["call", "message", "message", "result"],
			)
			assert.strictEqual(context[3]?.type, "result")
		}),
)
