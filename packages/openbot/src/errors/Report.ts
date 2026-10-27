import { Cause, Effect } from "effect"
import type { Execution } from "@openbot-build/domain"
import { Records, category } from "./Records.ts"

/** A service takes this function once, when its layer is built. */
export type Report = (
	operation: string,
	failure: unknown,
	executionId?: Execution.Id,
) => Effect.Effect<Execution.Failure>

/** Keep full failures in sealed records. The log gets only the safe record ID. */
export const make = Effect.gen(function* () {
	const records = yield* Records
	const report: Report = (operation, failure, executionId) => {
		const cause = Cause.isCause(failure) ? failure : Cause.fail(failure)
		return records.record(cause, category(cause), executionId).pipe(
			Effect.annotateLogs({ operation }),
			// Records keeps both causes in a Redacted failure if it cannot seal them.
			Effect.orDie,
		)
	}
	return report
})
