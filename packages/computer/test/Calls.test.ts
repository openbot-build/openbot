import { NodeServices } from "@effect/platform-node"
import { ComputersApi } from "@openbot-build/api"
import { assert, layer } from "@effect/vitest"
import {
	Array as Arr,
	Context,
	Effect,
	FileSystem,
	HashMap,
	Layer,
	Path,
	Schema,
} from "effect"
import { Base64 } from "effect/encoding"
import * as Calls from "../src/Calls.ts"

type Operation = ComputersApi.ConnectorCall["operation"]

/** The folder where relative paths start. All tests in this file share it. */
class Home extends Context.Service<Home, string>()(
	"@openbot-build/computer/test/Calls.test/Home",
) {}

const home = Layer.effect(
	Home,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		return yield* fs.makeTempDirectoryScoped({
			prefix: "openbot-computer-calls-",
		})
	}),
).pipe(Layer.provideMerge(NodeServices.layer))

const call = Effect.fnUntraced(function* (operation: Operation) {
	return yield* Calls.execute(
		{ id: "call-1", operation },
		{ home: yield* Home },
	)
})

/** Does the call, and gives the value of its `Done` reply. */
const done = Effect.fnUntraced(function* (operation: Operation) {
	const reply = yield* call(operation)
	assert.strictEqual(reply.id, "call-1")
	if (reply.result._tag !== "Done") return assert.fail(reply.result.message)
	return reply.result.value
})

layer(home, { excludeTestServices: true })((it) => {
	it.effect(
		"Write makes missing folders, and Read gives the content back",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				assert.strictEqual(
					yield* done({
						_tag: "Write",
						file: {
							path: "a/b/note.txt",
							encoding: "utf8",
							content: "hello ü",
						},
					}),
					null,
				)
				assert.strictEqual(
					yield* fs.readFileString(path.join(yield* Home, "a/b/note.txt")),
					"hello ü",
				)
				assert.deepStrictEqual(
					yield* done({ _tag: "Read", path: "a/b/note.txt", encoding: "utf8" }),
					{ path: "a/b/note.txt", encoding: "utf8", content: "hello ü" },
				)
			}),
	)

	it.effect("Write and Read work with base64 bytes", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const bytes = new Uint8Array([0, 1, 2, 250, 255])
			const file = path.join(yield* Home, "bytes.bin")
			yield* done({
				_tag: "Write",
				file: { path: file, encoding: "base64", content: Base64.encode(bytes) },
			})
			assert.deepStrictEqual(yield* fs.readFile(file), bytes)
			const read = yield* done({
				_tag: "Read",
				path: file,
				encoding: "base64",
			}).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(ComputersApi.FileContent)),
			)
			assert.strictEqual(read.content, Base64.encode(bytes))
		}),
	)

	it.effect("List gives the entries of a folder", () =>
		Effect.gen(function* () {
			const path = yield* Path.Path
			const folder = path.join(yield* Home, "list")
			yield* done({
				_tag: "Write",
				file: {
					path: path.join(folder, "file.txt"),
					encoding: "utf8",
					content: "12345",
				},
			})
			yield* done({
				_tag: "Write",
				file: {
					path: path.join(folder, "inner/x"),
					encoding: "utf8",
					content: "",
				},
			})
			const entries = yield* done({ _tag: "List", path: folder }).pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(Schema.Array(ComputersApi.FileEntry)),
				),
			)
			const byName = HashMap.fromIterable(
				Arr.map(entries, (entry) => [entry.name, entry] as const),
			)
			assert.strictEqual(HashMap.size(byName), 2)
			const file = yield* Effect.fromOption(HashMap.get(byName, "file.txt"))
			assert.strictEqual(file.kind, "file")
			assert.strictEqual(file.size, 5)
			const inner = yield* Effect.fromOption(HashMap.get(byName, "inner"))
			assert.strictEqual(inner.kind, "directory")
		}),
	)

	it.effect("Remove deletes a file or a folder", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const file = path.join(yield* Home, "remove.txt")
			yield* fs.writeFileString(file, "x")
			assert.strictEqual(yield* done({ _tag: "Remove", path: file }), null)
			assert.strictEqual(yield* fs.exists(file), false)
			yield* done({
				_tag: "Write",
				file: { path: "gone/inner/x", encoding: "utf8", content: "" },
			})
			yield* done({ _tag: "Remove", path: "gone" })
			assert.strictEqual(
				yield* fs.exists(path.join(yield* Home, "gone")),
				false,
			)
		}),
	)

	it.effect("a failed file call gives a Failed reply", () =>
		Effect.gen(function* () {
			const reply = yield* call({
				_tag: "Read",
				path: "missing.txt",
				encoding: "utf8",
			})
			assert.strictEqual(reply.id, "call-1")
			if (reply.result._tag !== "Failed")
				return assert.fail("A missing file must fail.")
			assert.strictEqual(reply.result.reason, "NotFound")
		}),
	)

	it.effect("a Failed reply names the error of the system", () =>
		Effect.gen(function* () {
			const reply = yield* call({ _tag: "Read", path: ".", encoding: "utf8" })
			if (reply.result._tag !== "Failed")
				return assert.fail("A Read of a folder must fail.")
			assert.match(reply.result.message, /EISDIR/)
			assert.strictEqual(reply.result.reason, "Failed")
		}),
	)

	it.effect("Screenshot and Desktop say that this machine has no desktop", () =>
		Effect.gen(function* () {
			for (const operation of [
				{ _tag: "Screenshot" } as const,
				{ _tag: "Desktop", actions: [] } as const,
			]) {
				const reply = yield* call(operation)
				assert.deepStrictEqual(reply.result, {
					_tag: "Failed",
					reason: "Failed",
					message: "This machine has no desktop.",
				})
			}
		}),
	)
})
