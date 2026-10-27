import { assert, it } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import { Prompt } from "effect/ai"
import {
	keepNewestImage,
	names,
} from "../src/plugins/computers/ComputerTools.ts"

it.effect("the model sees only the newest screenshot", () =>
	Effect.sync(() => {
		const shot = (id: string) =>
			Prompt.makeMessage("tool", {
				content: [
					Prompt.toolResultPart({
						id,
						name: names.screenshot,
						isFailure: false,
						providerExecuted: false,
						result: {
							width: 1,
							height: 1,
							openbot_image: { mediaType: "image/png", data: id },
						},
					}),
				],
			})
		const prompt = Prompt.fromMessages([
			Prompt.makeMessage("user", {
				content: [Prompt.makePart("text", { text: "hi" })],
			}),
			shot("first"),
			shot("second"),
		])
		const shown = keepNewestImage(prompt)
		assert.strictEqual(shown.content.length, prompt.content.length)
		const results = Arr.flatMap(shown.content, (message) =>
			message.role === "tool" ? message.content : [],
		)
		assert.deepStrictEqual(
			Arr.map(results, (part) =>
				part.type === "tool-result"
					? "openbot_image" in (part.result as object)
					: false,
			),
			[false, true],
		)
	}),
)
