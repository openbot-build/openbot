import { homedir } from "node:os"
import type { ComputersApi } from "@openbot-build/api"
import {
	Effect,
	FileSystem,
	Option,
	Path,
	type PlatformError,
	Schema,
} from "effect"
import * as Config from "./Config.ts"

/** A call that did not work. The message goes back to OpenBot in a `Failed` reply. */
export class CallFailed extends Schema.TaggedError<
	CallFailed,
	{ readonly brand: unique symbol }
>()("CallFailed", {
	message: Schema.String,
	reason: Schema.Literals(["NotFound", "Failed"]),
	/** The failure below, such as a file system error. */
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

const failed = (error: PlatformError.PlatformError) =>
	CallFailed.make({
		message: Config.platformErrorText(error),
		cause: error,
		reason: error.reason._tag === "NotFound" ? "NotFound" : "Failed",
	})

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

const list = (fs: FileSystem.FileSystem, path: Path.Path, folder: string) =>
	fs.readDirectory(folder).pipe(
		Effect.flatMap((names) =>
			Effect.forEach(
				names,
				(name) =>
					fs.lstat(path.join(folder, name)).pipe(
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
				// Node does file system work on a small pool of threads, so more at once is not faster.
				{ concurrency: 32 },
			),
		),
	)

const operate = Effect.fnUntraced(function* (
	operation: Operation,
	options: Options,
): Effect.fn.Return<
	Schema.Json,
	CallFailed,
	FileSystem.FileSystem | Path.Path
> {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const at = (file: string) => path.resolve(options.home, file)
	switch (operation._tag) {
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
				.makeDirectory(path.dirname(file), { recursive: true })
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
			return yield* list(fs, path, at(operation.path)).pipe(
				Effect.mapError(failed),
			)
		case "Remove":
			yield* fs
				.remove(at(operation.path), { recursive: true })
				.pipe(Effect.mapError(failed))
			return null
		case "Screenshot":
		case "Desktop":
			return yield* CallFailed.make({
				message: "This machine has no desktop.",
				reason: "Failed",
			})
	}
})

/** Does one call and answers with the same `id`. It never fails: a failure becomes a `Failed` reply. */
export const execute = (
	call: Call,
	options: Options,
): Effect.Effect<Reply, never, FileSystem.FileSystem | Path.Path> =>
	operate(call.operation, options).pipe(
		Effect.map((value): Reply => ({
			id: call.id,
			result: { _tag: "Done", value },
		})),
		Effect.catch((error) =>
			Effect.succeed<Reply>({
				id: call.id,
				result: {
					_tag: "Failed",
					message: error.message,
					reason: error.reason,
				},
			}),
		),
	)
