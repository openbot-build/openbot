import { assert, it } from "@effect/vitest"
import { Execution } from "@openbot-build/domain"
import {
	Cause,
	Effect,
	Exit,
	Logger,
	Queue,
	Ref,
	References,
	Redacted,
	Schedule,
	Schema,
	Scope,
} from "effect"
import { TestClock } from "effect/testing"
import * as Background from "../src/execution/Background.ts"
import { Records } from "../src/errors/Records.ts"
import * as ErrorRecordsFixture from "./ErrorRecordsFixture.ts"

const make = Effect.gen(function* () {
	const recorded = yield* ErrorRecordsFixture.make
	const work = yield* Background.make.pipe(
		Effect.provideService(Records, recorded.records),
	)
	return { ...work, failures: recorded.failures }
})
const everyMinute = Schedule.spaced("1 minute")

it.effect("a background loop runs at once and stops with its scope", () =>
	Effect.gen(function* () {
		const work = yield* make
		const runs = yield* Queue.unbounded<number>()
		const count = yield* Ref.make(0)
		const scope = yield* Scope.make()
		yield* work
			.repeat(
				Ref.updateAndGet(count, (n) => n + 1).pipe(
					Effect.flatMap((n) => Queue.offer(runs, n)),
				),
				{ schedule: everyMinute, message: "The test work failed" },
			)
			.pipe(Scope.provide(scope))
		assert.strictEqual(yield* Queue.take(runs), 1)
		yield* TestClock.adjust("59 seconds")
		assert.strictEqual(yield* Queue.size(runs), 0)
		yield* TestClock.adjust("1 second")
		assert.strictEqual(yield* Queue.take(runs), 2)
		yield* Scope.close(scope, Exit.void)
		yield* TestClock.adjust("10 minutes")
		assert.strictEqual(yield* Queue.size(runs), 0)
		assert.deepStrictEqual(yield* work.failures, [])
	}),
)

it.effect(
	"failed runs keep private causes and the next run still comes",
	() => {
		let logs: ReadonlyArray<unknown> = []
		return Effect.gen(function* () {
			const work = yield* make
			const runs = yield* Queue.unbounded<number>()
			const count = yield* Ref.make(0)
			yield* work
				.repeat(
					Ref.updateAndGet(count, (n) => n + 1).pipe(
						Effect.flatMap((n) =>
							n === 1
								? Effect.fail("private-query")
								: n === 2
									? Effect.die("private-driver-result")
									: Queue.offer(runs, n),
						),
					),
					{ schedule: everyMinute, message: "The test work failed" },
				)
				.pipe(Effect.annotateLogs({ source: "test" }))
			yield* TestClock.adjust("2 minutes")
			assert.strictEqual(yield* Queue.take(runs), 3)
			const saved = yield* work.failures
			assert.strictEqual(saved.length, 2)
			assert.match(Cause.pretty(saved[0]!.cause), /private-query/)
			assert.match(Cause.pretty(saved[1]!.cause), /private-driver-result/)
			const output = yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.Unknown),
			)(logs)
			assert.notMatch(output, /private-/)
			assert.include(output, "test-error-1")
			assert.include(output, "test-error-2")
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Logger.layer([
					Logger.make((log) => {
						logs = [
							...logs,
							{
								message: log.message,
								cause: Cause.pretty(log.cause),
								annotations: log.fiber.getRef(References.CurrentLogAnnotations),
							},
						]
					}),
				]),
			),
		)
	},
)

it.effect(
	"an interruption inside a run has no error record and the next run still comes",
	() =>
		Effect.gen(function* () {
			const work = yield* make
			const runs = yield* Queue.unbounded<number>()
			const count = yield* Ref.make(0)
			yield* work.repeat(
				Ref.updateAndGet(count, (n) => n + 1).pipe(
					Effect.flatMap((n) =>
						n === 1 ? Effect.interrupt : Queue.offer(runs, n),
					),
				),
				{ schedule: everyMinute, message: "The test work failed" },
			)
			yield* TestClock.adjust("1 minute")
			assert.strictEqual(yield* Queue.take(runs), 2)
			assert.deepStrictEqual(yield* work.failures, [])
		}).pipe(Effect.scoped),
)

it.effect(
	"a failed step keeps its full cause but a plain interruption has no record",
	() =>
		Effect.gen(function* () {
			const work = yield* make
			yield* Effect.fail("private-step").pipe(
				work.logFailure("The test step failed"),
			)
			yield* Effect.interrupt.pipe(work.logFailure("The test step failed"))
			const saved = yield* work.failures
			assert.strictEqual(saved.length, 1)
			assert.match(Cause.pretty(saved[0]!.cause), /private-step/)
		}),
)

it.effect(
	"a failed error record stops the background step with its full redacted cause",
	() =>
		Effect.gen(function* () {
			const work = yield* Background.make.pipe(
				Effect.provideService(
					Records,
					Records.of({
						record: (cause) =>
							Effect.fail(
								Execution.StorageError.make({
									cause: Redacted.make(
										Cause.combine(cause, Cause.die("private-seal-error")),
									),
								}),
							),
					}),
				),
			)
			const ended = yield* Effect.fail("private-step").pipe(
				work.logFailure("The test step failed"),
				Effect.exit,
			)
			assert.isTrue(Exit.isFailure(ended))
			if (!Exit.isFailure(ended)) return
			const reason = ended.cause.reasons[0]
			assert.strictEqual(reason?._tag, "Die")
			if (
				reason?._tag !== "Die" ||
				!Schema.is(Execution.StorageError)(reason.defect)
			)
				return
			assert.isTrue(Redacted.isRedacted(reason.defect.cause))
			if (!Redacted.isRedacted(reason.defect.cause)) return
			const retained = Redacted.value(reason.defect.cause)
			assert.isTrue(Cause.isCause(retained))
			if (!Cause.isCause(retained)) return
			assert.match(Cause.pretty(retained), /private-step/)
			assert.match(Cause.pretty(retained), /private-seal-error/)
		}),
)
