import { assert, it } from "@effect/vitest"
import { Effect, Option, Ref, Stream } from "effect"
import { LanguageModel, Prompt, Response } from "effect/ai"
import { withFiles } from "../src/files/ModelFiles.ts"

it.effect(
	"saved attachment references omit bytes while normal input files still load their content",
	() =>
		Effect.gen(function* () {
			const seen = yield* Ref.make(Prompt.empty)
			const loads = yield* Ref.make(0)
			const model = yield* LanguageModel.make({
				generateText: ({ prompt }) =>
					Ref.set(seen, prompt).pipe(
						Effect.as([Response.makePart("text", { text: "ok" })]),
					),
				streamText: () => Stream.empty,
			})
			const bytes = new Uint8Array([0, 1, 2, 3])
			const wrapped = withFiles(model, () =>
				Ref.update(loads, (count) => count + 1).pipe(
					Effect.as(
						Option.some({
							mediaType: "application/pdf",
							fileName: "input.pdf",
							bytes,
						}),
					),
				),
			)
			const attachment = Prompt.make([
				{
					role: "user",
					content: [
						Prompt.makePart("file", {
							mediaType:
								"application/vnd.openxmlformats-officedocument.presentationml.presentation",
							fileName: "slides.pptx",
							data: new URL("openbot-file:file_slides"),
							options: { openbot: { delivery: "attachment" } },
						}),
					],
				},
			])
			yield* wrapped.generateText({ prompt: attachment })
			assert.strictEqual(yield* Ref.get(loads), 0)
			const saved = (yield* Ref.get(seen)).content[0]!
			assert.strictEqual(saved.role, "user")
			if (saved.role !== "user" || saved.content[0]?.type !== "text")
				return yield* Effect.die("Expected a reference note")
			assert.include(saved.content[0].text, "file contents are not included")
			assert.include(saved.content[0].text, "openbot-file:file_slides")
			yield* wrapped.generateText({
				prompt: Prompt.make([
					{
						role: "user",
						content: [
							Prompt.makePart("file", {
								mediaType: "application/pdf",
								fileName: "input.pdf",
								data: new URL("openbot-file:file_input"),
							}),
						],
					},
				]),
			})
			assert.strictEqual(yield* Ref.get(loads), 1)
			const normal = (yield* Ref.get(seen)).content[0]!
			if (normal.role !== "user" || normal.content[0]?.type !== "file")
				return yield* Effect.die("Expected a normal file part")
			assert.deepStrictEqual(normal.content[0].data, bytes)
		}),
)
