import { Effect, Layer } from "effect"
import { Base64 } from "effect/encoding"
import { Computers as Data } from "@openbot-build/domain"
import { ComputerFiles } from "@openbot-build/apps-contract/computers/ComputerFiles"
import * as Failures from "@openbot-build/server-kernel/Failures"
import { Computers } from "./Computers.ts"

export const layer = Layer.effect(
	ComputerFiles,
	Effect.gen(function* () {
		const computers = yield* Computers
		return ComputerFiles.of({
			read: (identity, id, path) =>
				Effect.gen(function* () {
					const { machine } = yield* computers.machine(identity, id)
					const file = yield* machine.shell.read(path, "base64")
					return file.encoding === "base64"
						? yield* Effect.fromResult(Base64.decode(file.content))
						: new TextEncoder().encode(file.content)
				}).pipe(
					Failures.replace("Could not read the Computer file", () =>
						Data.ComputersUnavailable.make({}),
					),
				),
		})
	}),
)
