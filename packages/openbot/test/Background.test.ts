import { assert, it } from "@effect/vitest"
import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	Logger,
	Queue,
	Ref,
	References,
	Schedule,
	Scope,
} from "effect"
import { TestClock } from "effect/testing"
import * as Background from "../src/app/Background.ts"

interface Line {
	readonly level: string
	readonly message: unknown
	readonly cause: Cause.Cause<unknown>
	readonly annotations: Readonly<Record<string, unknown>>
}

/** Keeps every log line of a test in place of the normal output. */
const collect = () => {
	let lines: ReadonlyArray<Line> = []
	const layer = Logger.layer([
		Logger.make((log) => {
			lines = [
				...lines,
				{
					level: log.logLevel,
					message: log.message,
					cause: log.cause,
					annotations: log.fiber.getRef(References.CurrentLogAnnotations),
				},
			]
		}),
	])
	return { layer, lines: () => lines }
}

const everyMinute = Schedule.spaced("1 minute")

it.effect(
	"a background loop runs at once, then on its schedule, and stops without a log when its scope closes",
	() => {
		const logs = collect()
		return Effect.gen(function* () {
			const runs = yield* Queue.unbounded<number>()
			const count = yield* Ref.make(0)
			const scope = yield* Scope.make()
			yield* Background.repeat(
				Ref.updateAndGet(count, (n) => n + 1).pipe(
					Effect.flatMap((n) => Queue.offer(runs, n)),
				),
				{ schedule: everyMinute, message: "The test work failed" },
			).pipe(Scope.provide(scope))
			assert.strictEqual(yield* Queue.take(runs), 1)
			yield* TestClock.adjust("59 seconds")
			assert.strictEqual(yield* Queue.size(runs), 0)
			yield* TestClock.adjust("1 second")
			assert.strictEqual(yield* Queue.take(runs), 2)
			yield* Scope.close(scope, Exit.void)
			yield* TestClock.adjust("10 minutes")
			assert.strictEqual(yield* Queue.size(runs), 0)
			assert.deepStrictEqual(logs.lines(), [])
		}).pipe(Effect.provide(logs.layer))
	},
)

it.effect(
	"a failed run is logged with its cause and the annotations of the caller, and the next run still comes",
	() => {
		const logs = collect()
		return Effect.gen(function* () {
			const runs = yield* Queue.unbounded<number>()
			const count = yield* Ref.make(0)
			yield* Background.repeat(
				Ref.updateAndGet(count, (n) => n + 1).pipe(
					Effect.flatMap((n) =>
						n === 1
							? Effect.fail("The database is down")
							: n === 2
								? Effect.die("A broken rule")
								: Queue.offer(runs, n),
					),
				),
				{ schedule: everyMinute, message: "The test work failed" },
			).pipe(Effect.annotateLogs({ source: "test" }))
			yield* TestClock.adjust("2 minutes")
			assert.strictEqual(yield* Queue.take(runs), 3)
			const lines = logs.lines()
			assert.deepStrictEqual(
				Arr.map(lines, (line) => [line.level, line.message, line.annotations]),
				[
					["Warn", ["The test work failed"], { source: "test" }],
					["Warn", ["The test work failed"], { source: "test" }],
				],
			)
			const [failed, died] = lines
			assert.ok(failed !== undefined && Cause.hasFails(failed.cause))
			assert.ok(died !== undefined && Cause.hasDies(died.cause))
		}).pipe(Effect.scoped, Effect.provide(logs.layer))
	},
)

it.effect(
	"an interruption inside a run is not logged, and the next run still comes",
	() => {
		const logs = collect()
		return Effect.gen(function* () {
			const runs = yield* Queue.unbounded<number>()
			const count = yield* Ref.make(0)
			yield* Background.repeat(
				Ref.updateAndGet(count, (n) => n + 1).pipe(
					Effect.flatMap((n) =>
						n === 1 ? Effect.interrupt : Queue.offer(runs, n),
					),
				),
				{ schedule: everyMinute, message: "The test work failed" },
			)
			yield* TestClock.adjust("1 minute")
			assert.strictEqual(yield* Queue.take(runs), 2)
			assert.deepStrictEqual(logs.lines(), [])
		}).pipe(Effect.scoped, Effect.provide(logs.layer))
	},
)

it.effect(
	"logFailure logs a failure with its cause and goes on, but does not log an interruption",
	() => {
		const logs = collect()
		return Effect.gen(function* () {
			yield* Effect.fail("The file is gone").pipe(
				Background.logFailure("The test step failed"),
			)
			yield* Effect.interrupt.pipe(
				Background.logFailure("The test step failed"),
			)
			const lines = logs.lines()
			assert.deepStrictEqual(
				Arr.map(lines, (line) => [line.level, line.message]),
				[["Warn", ["The test step failed"]]],
			)
			const [failed] = lines
			assert.ok(failed !== undefined && Cause.hasFails(failed.cause))
		}).pipe(Effect.provide(logs.layer))
	},
)

it.effect("logFailure can write its line at another level", () => {
	const logs = collect()
	return Effect.gen(function* () {
		yield* Effect.fail("The Chat is busy").pipe(
			Background.logFailure("The test step failed", { level: "Debug" }),
		)
		assert.deepStrictEqual(
			Arr.map(logs.lines(), (line) => [line.level, line.message]),
			[["Debug", ["The test step failed"]]],
		)
	}).pipe(
		Effect.provide(logs.layer),
		Effect.provideService(References.MinimumLogLevel, "All"),
	)
})
