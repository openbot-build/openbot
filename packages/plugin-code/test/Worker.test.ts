import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import type {
	FromWorker,
	ToWorker,
} from "@openbot-build/apps-contract/code/Protocol"
import { Effect, FileSystem, Path } from "effect"
import { Worker } from "node:worker_threads"

const start = {
	type: "start",
	code: "return 1 + 2",
	bindings: [],
	vault: [],
	seed: 1,
	clock: 0,
	limits: {
		timeoutMs: 2_000,
		memoryBytes: 32 * 1024 * 1024,
		outputBytes: 4_096,
	},
} satisfies ToWorker

// The test runs the built worker, as the server does. Node loads it outside of
// vitest, so it uses only the dependencies of this package.
layer(NodeServices.layer)((it) => {
	it.effect(
		"the built Code Mode worker runs a program and gives its value",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					// `Sandbox.js` looks for `Worker.js` in its own folder.
					const sandbox = yield* path.fromFileUrl(
						new URL("../dist/Sandbox.js", import.meta.url),
					)
					assert.isTrue(yield* fs.exists(sandbox))
					const worker = yield* Effect.acquireRelease(
						Effect.sync(
							() => new Worker(new URL("../dist/Worker.js", import.meta.url)),
						),
						(worker) => Effect.promise(() => worker.terminate()),
					)
					const answer = yield* Effect.callback<FromWorker>((resume) => {
						const message = (value: FromWorker) => resume(Effect.succeed(value))
						// An error of the worker fails the test, so it is a defect.
						const error = (cause: unknown) => resume(Effect.die(cause))
						worker.once("message", message)
						worker.once("error", error)
						worker.postMessage(start)
						return Effect.sync(() => {
							worker.off("message", message)
							worker.off("error", error)
						})
					})
					assert.deepStrictEqual(answer, { type: "done", value: "3", logs: [] })
				}),
			),
	)
})
