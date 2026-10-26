import { assert, it } from "@effect/vitest"
import { FilesApi } from "@openbot-build/api"
import { Array as Arr, Effect, Option, Ref, Result } from "effect"
import { Prompt } from "effect/ai"
import * as ModelFiles from "../src/files/ModelFiles.ts"
import { fileUrl } from "../src/files/Refs.ts"

const caller = {
	kind: "member" as const,
	organizationId: "one",
	userId: "alice",
}
const id = FilesApi.FileId.make("file_image")
const bytes = new Uint8Array([1, 2, 3])
const file: FilesApi.FileObject = {
	id,
	object: "file",
	filename: "image.png",
	mediaType: "image/png",
	bytes: bytes.length,
	status: "ready",
	createdAt: 0,
}
const prompt = (url = fileUrl(id)) =>
	Prompt.fromMessages([
		Prompt.makeMessage("user", {
			content: [Prompt.makePart("file", { mediaType: "image/png", data: url })],
		}),
	])

it.effect("shared context checks file ownership before reading bytes", () =>
	Effect.gen(function* () {
		const reads = yield* Ref.make(0)
		const result = yield* ModelFiles.context(
			{
				get: (owner, found) => {
					assert.deepStrictEqual(owner, caller)
					assert.strictEqual(found, id)
					return Effect.fail(FilesApi.FileNotFound.make({ id }))
				},
				load: () =>
					Ref.update(reads, (n) => n + 1).pipe(Effect.as(Option.none())),
			},
			caller,
			prompt(),
		).pipe(Effect.result)
		assert.ok(Result.isFailure(result))
		assert.strictEqual(result.failure.reason, "context")
		assert.strictEqual(yield* Ref.get(reads), 0)
	}),
)

it.effect(
	"shared context rejects missing files and outside URLs instead of replacing them with text",
	() =>
		Effect.gen(function* () {
			const source = {
				get: () => Effect.succeed(file),
				load: () => Effect.succeedNone,
			}
			for (const value of [
				prompt(),
				prompt(new URL("https://example.com/image.png")),
			]) {
				const result = yield* ModelFiles.context(source, caller, value).pipe(
					Effect.result,
				)
				assert.ok(Result.isFailure(result))
				assert.strictEqual(result.failure.reason, "context")
			}
		}),
)

it.effect(
	"shared context preserves image bytes and leaves the stored file reference unchanged",
	() =>
		Effect.gen(function* () {
			const stored = prompt()
			const resolved = yield* ModelFiles.context(
				{
					get: () => Effect.succeed(file),
					load: () =>
						Effect.succeedSome({
							fileName: file.filename,
							mediaType: file.mediaType,
							bytes,
						}),
				},
				caller,
				stored,
			)
			const parts = Arr.flatMap(resolved.content, (message) =>
				message.role === "user" ? message.content : [],
			)
			const found = Arr.findFirst(parts, (part) => part.type === "file")
			assert.ok(Option.isSome(found) && found.value.type === "file")
			assert.deepStrictEqual(found.value.data, bytes)
			const original = Arr.flatMap(stored.content, (message) =>
				message.role === "user" ? message.content : [],
			)
			assert.ok(
				Arr.some(
					original,
					(part) => part.type === "file" && part.data instanceof URL,
				),
			)
		}),
)
