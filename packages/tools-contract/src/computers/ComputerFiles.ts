import { Context, type Effect } from "effect"
import type { Computers, ExecutionIdentity } from "@openbot-build/domain"

/** Reads a file with the saved caller and Bot rights. */
export class ComputerFiles extends Context.Service<
	ComputerFiles,
	{
		readonly read: (
			identity: ExecutionIdentity,
			id: string,
			path: string,
		) => Effect.Effect<Uint8Array, Computers.ComputersUnavailable>
	}
>()("@openbot-build/tools-contract/computers/ComputerFiles") {}
