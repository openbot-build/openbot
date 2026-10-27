import { Execution } from "@openbot-build/domain"
import { Array as Arr, Cause, Effect, Layer, Ref } from "effect"
import { Records } from "../src/errors/Records.ts"

/** Unit tests keep full failures in memory and log only their safe reference. */
export const make = Effect.gen(function* () {
	const saved = yield* Ref.make<
		ReadonlyArray<{
			readonly cause: Cause.Cause<unknown>
			readonly failure: Execution.Failure
		}>
	>([])
	const records = Records.of({
		record: (cause, category) =>
			Ref.modify(saved, (entries) => {
				const failure: Execution.Failure = {
					errorId: Execution.ErrorId.make(`test-error-${entries.length + 1}`),
					category,
				}
				return [failure, Arr.append(entries, { cause, failure })]
			}).pipe(
				Effect.tap((failure) =>
					Effect.logError("The test saved an error record.").pipe(
						Effect.annotateLogs(failure),
					),
				),
			),
	})
	return { records, failures: Ref.get(saved) }
})

export const layer = Layer.effect(
	Records,
	Effect.map(make, ({ records }) => records),
)
