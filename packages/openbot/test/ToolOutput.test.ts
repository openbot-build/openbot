import { assert, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Prompt } from "effect/ai"
import { outputCodec } from "../src/chats/ToolSteps.ts"

it.effect("saved tool output keeps text and image bytes", () =>
	Effect.gen(function* () {
		const output = {
			id: "call",
			name: "Screen",
			result: { width: 2, height: 1 },
			isFailure: false,
			preliminary: false,
			modelOutput: [
				Prompt.makePart("text", { text: "The screen" }),
				Prompt.makePart("file", {
					mediaType: "image/png",
					data: new Uint8Array([1, 2, 3]),
				}),
			],
		}
		const saved = yield* Schema.encodeEffect(outputCodec)(output)
		assert.property(saved, "modelOutput")
		assert.notProperty(saved, "content")
		assert.deepStrictEqual(
			yield* Schema.decodeEffect(outputCodec)(saved),
			output,
		)
	}),
)
