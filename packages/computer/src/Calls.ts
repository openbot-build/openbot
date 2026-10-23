// These functions take all their inputs at once. A pipeable form does not help here.
// @effect-diagnostics missingPipeableSignature:off
import { spawn } from "node:child_process"
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { ComputersApi } from "@openbot-build/api"
import { Data, Effect, type Schema } from "effect"

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
	Effect.callback<ComputersApi.CommandResult, CallFailed>((resume) => {
		const started = Date.now()
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
					durationMs: Date.now() - started,
				}),
			)
		})
		return Effect.sync(() => {
			clearTimeout(timer)
			stop()
		})
	})

const list = async (folder: string) => {
	const names = await readdir(folder)
	return Promise.all(
		names.map(async (name) => {
			const info = await lstat(join(folder, name))
			return {
				name,
				kind: info.isSymbolicLink()
					? ("link" as const)
					: info.isDirectory()
						? ("directory" as const)
						: ("file" as const),
				size: info.size,
				modifiedAt: info.mtimeMs,
			}
		}),
	)
}

const operate = (
	operation: Operation,
	options: Options,
): Effect.Effect<Schema.Json, CallFailed> => {
	const at = (path: string) => resolve(options.home, path)
	const attempt = <A>(work: () => Promise<A>) =>
		Effect.tryPromise({
			try: work,
			catch: (error) =>
				new CallFailed({
					message: error instanceof Error ? error.message : String(error),
				}),
		})
	switch (operation._tag) {
		case "Run": {
			// Node says "spawn bash ENOENT" when the folder is missing, so check the folder first.
			const folder = at(operation.request.cwd ?? ".")
			return attempt(() => stat(folder)).pipe(
				Effect.mapError(
					() =>
						new CallFailed({ message: `The folder ${folder} does not exist.` }),
				),
				Effect.flatMap((info) =>
					info.isDirectory()
						? run(operation.request, options)
						: Effect.fail(
								new CallFailed({ message: `${folder} is not a folder.` }),
							),
				),
			)
		}
		case "Read":
			return attempt(async () => ({
				path: operation.path,
				encoding: operation.encoding,
				content: (await readFile(at(operation.path))).toString(
					operation.encoding,
				),
			}))
		case "Write":
			return attempt(async () => {
				const file = at(operation.file.path)
				await mkdir(dirname(file), { recursive: true })
				await writeFile(
					file,
					Buffer.from(operation.file.content, operation.file.encoding),
				)
				return null
			})
		case "List":
			return attempt(() => list(at(operation.path)))
		case "Remove":
			return attempt(async () => {
				await rm(at(operation.path), { recursive: true })
				return null
			})
		case "Screenshot":
		case "Desktop":
			return Effect.fail(
				new CallFailed({ message: "This machine has no desktop." }),
			)
	}
}

/** Does one call and answers with the same `id`. It never fails: a failure becomes a `Failed` reply. */
export const execute = (call: Call, options: Options): Effect.Effect<Reply> =>
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
