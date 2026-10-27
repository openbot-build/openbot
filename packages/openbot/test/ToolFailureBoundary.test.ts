import { assert, it } from "@effect/vitest"
import { Execution } from "@openbot-build/domain"
import { Cause, Effect, Exit, Schema } from "effect"
import { entry } from "../src/plugins/ToolEntry.ts"
import { codec, snapshot } from "../src/errors/Snapshot.ts"
import { Records } from "../src/errors/Records.ts"

class Inside extends Schema.TaggedError<
	Inside,
	{ readonly brand: unique symbol }
>()("Inside", { detail: Schema.String }) {}
it.effect("a tool failure has a saved cause and keeps the execution link", () =>
	Effect.gen(function* () {
		const executionId = Execution.Id.make("test-execution")
		const failure: Execution.Failure = {
			category: "unavailable",
			errorId: Execution.ErrorId.make("test-error"),
		}
		let recorded = 0
		const records = Records.of({
			record: (cause, _category, id) =>
				Effect.gen(function* () {
					assert.strictEqual(id, executionId)
					assert.match(
						yield* cause.pipe(snapshot, Schema.encodeEffect(codec)),
						/private-provider-detail/,
					)
					recorded++
					return failure
				}).pipe(Effect.orDie),
		})
		const make = (
			work: Effect.Effect<Schema.Json, Inside | Execution.Failure>,
		) =>
			entry(
				"test",
				"Read a record.",
				{ type: "object", properties: {} },
				() => work,
				{ records, executionId },
			)
		const context = {
			name: "test",
			toolCallId: "test-call",
			preliminary: () => Effect.void,
		}
		const result = yield* make(
			Effect.fail(Inside.make({ detail: "private-provider-detail" })),
		)
			.handle({}, context)
			.pipe(Effect.flip)
		assert.deepStrictEqual(result, failure)
		assert.strictEqual(recorded, 1)
		const repeated = yield* make(Effect.fail(failure))
			.handle({}, context)
			.pipe(Effect.flip)
		assert.deepStrictEqual(repeated, failure)
		assert.strictEqual(recorded, 1)
		const interrupted = yield* make(Effect.interrupt)
			.handle({}, context)
			.pipe(Effect.exit)
		assert.isTrue(Exit.isFailure(interrupted))
		if (Exit.isFailure(interrupted))
			assert.isTrue(Cause.hasInterruptsOnly(interrupted.cause))
		assert.strictEqual(recorded, 1)
	}),
)
