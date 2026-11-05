import type { Caller, Execution } from "@openbot-build/domain"
import { Context, type Effect } from "effect"
import type { Key, ServiceExecution } from "../execution/Store.ts"
import type { Input } from "./Executions.ts"

/**
 * Reads the records that the data upgrade imported from old executions. The
 * same policy as the public execution API checks each read.
 */
export class ImportedRecords extends Context.Service<
	ImportedRecords,
	{
		readonly read: (
			key: Key,
			actor: Caller,
		) => Effect.Effect<
			{ readonly saved: ServiceExecution; readonly input: Input },
			Execution.Forbidden | Execution.NotFound | Execution.StorageError
		>
	}
	// @effect-diagnostics-next-line deterministicKeys:off -- The key keeps the name it had in the openbot package, so code built for that name still finds this service.
>()("@openbot-build/openbot/server-execution/imported/ImportedRecords") {}
