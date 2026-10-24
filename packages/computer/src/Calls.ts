// These functions take all their inputs at once. A pipeable form does not help here.
// @effect-diagnostics missingPipeableSignature:off
import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { ComputersApi } from "@openbot-build/api"
import {
	Clock,
	Data,
	Effect,
	FileSystem,
	Option,
	type PlatformError,
	type Schema,
} from "effect"

/** A call that did not work. The message goes back to OpenBot in a `Failed` reply. */
export class CallFailed extends Data.TaggedError("CallFailed")<{
	readonly message: string
}> {}

type Call = ComputersApi.ConnectorCall
type Reply = ComputersApi.ConnectorReply
type Operation = Call["operation"]

export interface Options {
	/** The most bytes to keep of stdout, and the same again of stderr. */
	readonly maxOutput: number
	/** Where commands run and where relative paths start when the call gives no folder. */
	readonly home: string
}

export const defaultOptions = (): Options => ({
	maxOutput: 1024 * 1024,
	home: homedir(),
})

const defaultTimeoutSeconds = 60

/** Keeps only the last `max` bytes of a stream. */
const tail = (max: number) => {
	let chunks: Array<Buffer> = []
	let size = 0
	let truncated = false
	return {
		push: (chunk: Buffer) => {
			chunks.push(chunk)
			size += chunk.length
			while (size > max) {
				truncated = true
				const first = chunks[0]!
				const extra = size - max
				if (first.length <= extra) {
					chunks.shift()
					size -= first.length
				} else {
					chunks[0] = first.subarray(extra)
					size -= extra
				}
			}
		},
		done: () => {
			const text = Buffer.concat(chunks).toString("utf8")
			chunks = []
			return { text, truncated }
		},
	}
}

/**
 * Runs a command with `bash -lc`. The command gets its own process group,
 * so a timeout or a lost connection stops the command and all its children.
 */
export const run = (
	request: ComputersApi.RunCommandRequest,
	options: Options,
): Effect.Effect<ComputersApi.CommandResult, CallFailed> =>
	Effect.gen(function* () {
		const started = yield* Clock.currentTimeMillis
		const result = yield* spawnCommand(request, options)
		const ended = yield* Clock.currentTimeMillis
		return { ...result, durationMs: ended - started }
	})

type Spawned = Omit<ComputersApi.CommandResult, "durationMs">

/**
 * The Node.js process API works with callbacks, so this one adapter speaks to it.
 * The finalizer kills the process group when the fiber is interrupted.
 */
const spawnCommand = (
	request: ComputersApi.RunCommandRequest,
	options: Options,
): Effect.Effect<Spawned, CallFailed> =>
	Effect.callback<Spawned, CallFailed>((resume) => {
		const stdout = tail(options.maxOutput)
		const stderr = tail(options.maxOutput)
		let timedOut = false
		let finished = false
		const child = spawn("bash", ["-lc", request.command], {
			cwd: resolve(options.home, request.cwd ?? "."),
			env: { ...process.env, ...request.env },
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		})
		const stop = () => {
			if (finished || child.pid === undefined) return
			try {
				process.kill(-child.pid, "SIGKILL")
			} catch {
				// The process group is already gone.
			}
		}
		const timer = setTimeout(
			() => {
				timedOut = true
				stop()
			},
			(request.timeout ?? defaultTimeoutSeconds) * 1000,
		)
		child.stdout.on("data", stdout.push)
		child.stderr.on("data", stderr.push)
		child.on("error", (error) => {
			finished = true
			clearTimeout(timer)
			resume(Effect.fail(new CallFailed({ message: error.message })))
		})
		child.on("close", (code) => {
			if (finished) return
			finished = true
			clearTimeout(timer)
			const out = stdout.done()
			const err = stderr.done()
			resume(
				Effect.succeed({
					exitCode: timedOut ? null : code,
					stdout: out.text,
					stderr: err.text,
					truncated: out.truncated || err.truncated,
				}),
			)
		})
		return Effect.sync(() => {
			clearTimeout(timer)
			stop()
		})
	})

const kindOf = (type: FileSystem.File.Type) =>
	type === "SymbolicLink"
		? ("link" as const)
		: type === "Directory"
			? ("directory" as const)
			: ("file" as const)

const failed = (error: PlatformError.PlatformError) =>
	new CallFailed({ message: error.message })

const list = (fs: FileSystem.FileSystem, folder: string) =>
	fs.readDirectory(folder).pipe(
		Effect.flatMap((names) =>
			Effect.forEach(
				names,
				(name) =>
					fs.lstat(join(folder, name)).pipe(
						Effect.map((info) => ({
							name,
							kind: kindOf(info.type),
							size: Number(info.size),
							modifiedAt: Option.match(info.mtime, {
								onNone: () => 0,
								onSome: (date) => date.getTime(),
							}),
						})),
					),
				{ concurrency: "unbounded" },
			),
		),
	)

const operate = Effect.fnUntraced(function* (
	operation: Operation,
	options: Options,
): Effect.fn.Return<Schema.Json, CallFailed, FileSystem.FileSystem> {
	const fs = yield* FileSystem.FileSystem
	const at = (path: string) => resolve(options.home, path)
	switch (operation._tag) {
		case "Run": {
			// Node says "spawn bash ENOENT" when the folder is missing, so check the folder first.
			const folder = at(operation.request.cwd ?? ".")
			const info = yield* fs.stat(folder).pipe(
				Effect.mapError(
					() =>
						new CallFailed({
							message: `The folder ${folder} does not exist.`,
						}),
				),
			)
			if (info.type !== "Directory")
				return yield* new CallFailed({ message: `${folder} is not a folder.` })
			return yield* run(operation.request, options)
		}
		case "Read": {
			const bytes = yield* fs
				.readFile(at(operation.path))
				.pipe(Effect.mapError(failed))
			return {
				path: operation.path,
				encoding: operation.encoding,
				content: Buffer.from(bytes).toString(operation.encoding),
			}
		}
		case "Write": {
			const file = at(operation.file.path)
			yield* fs
				.makeDirectory(dirname(file), { recursive: true })
				.pipe(
					Effect.andThen(
						fs.writeFile(
							file,
							Buffer.from(operation.file.content, operation.file.encoding),
						),
					),
					Effect.mapError(failed),
				)
			return null
		}
		case "List":
			return yield* list(fs, at(operation.path)).pipe(Effect.mapError(failed))
		case "Remove":
			yield* fs
				.remove(at(operation.path), { recursive: true })
				.pipe(Effect.mapError(failed))
			return null
		case "Screenshot":
		case "Desktop":
			return yield* new CallFailed({ message: "This machine has no desktop." })
	}
})

/** Does one call and answers with the same `id`. It never fails: a failure becomes a `Failed` reply. */
export const execute = (
	call: Call,
	options: Options,
): Effect.Effect<Reply, never, FileSystem.FileSystem> =>
	operate(call.operation, options).pipe(
		Effect.map((value): Reply => ({
			id: call.id,
			result: { _tag: "Done", value },
		})),
		Effect.catch((error) =>
			Effect.succeed<Reply>({
				id: call.id,
				result: { _tag: "Failed", message: error.message },
			}),
		),
	)
