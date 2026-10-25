// These functions take all their inputs at once. A pipeable form does not help here.
// @effect-diagnostics missingPipeableSignature:off
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { ComputersApi } from "@openbot-build/api"
import { Data, Effect, FileSystem, Option, type Schema } from "effect"

/** A call that did not work. The message goes back to OpenBot in a `Failed` reply. */
export class CallFailed extends Data.TaggedError("CallFailed")<{
	readonly message: string
}> {}

type Call = ComputersApi.ConnectorCall
type Reply = ComputersApi.ConnectorReply
type Operation = Call["operation"]

export interface Options {
	/** Where relative paths start. */
	readonly home: string
}

export const defaultOptions = (): Options => ({ home: homedir() })

const kindOf = (type: FileSystem.File.Type) =>
	type === "SymbolicLink"
		? ("link" as const)
		: type === "Directory"
			? ("directory" as const)
			: ("file" as const)

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
		case "Read": {
			const bytes = yield* fs
				.readFile(at(operation.path))
				.pipe(
					Effect.mapError(
						(error) => new CallFailed({ message: error.message }),
					),
				)
			return {
				path: operation.path,
				encoding: operation.encoding,
				content: Buffer.from(bytes).toString(operation.encoding),
			}
		}
		case "Write": {
			const file = at(operation.file.path)
			yield* fs.makeDirectory(dirname(file), { recursive: true }).pipe(
				Effect.andThen(
					fs.writeFile(
						file,
						Buffer.from(operation.file.content, operation.file.encoding),
					),
				),
				Effect.mapError((error) => new CallFailed({ message: error.message })),
			)
			return null
		}
		case "List":
			return yield* list(fs, at(operation.path)).pipe(
				Effect.mapError((error) => new CallFailed({ message: error.message })),
			)
		case "Remove":
			yield* fs
				.remove(at(operation.path), { recursive: true })
				.pipe(
					Effect.mapError(
						(error) => new CallFailed({ message: error.message }),
					),
				)
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
