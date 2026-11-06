import { assert, it } from "@effect/vitest"
import { Graft } from "@graftland/graft"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Effect,
	Layer,
	Logger,
	Redacted,
	Ref,
	References,
	Stream,
	String as Str,
} from "effect"
import { TestClock } from "effect/testing"
import * as PluginFailures from "../src/PluginFailures.ts"
import * as PluginLogs from "../src/PluginLogs.ts"
import { Records } from "@openbot-build/server-kernel/Records"
import * as Feature from "@openbot-build/server-plugin/Feature"

interface Line {
	readonly message: ReadonlyArray<unknown>
	readonly cause: Cause.Cause<unknown>
	readonly annotations: Readonly<Record<string, unknown>>
}

/** A logger that keeps each line, and a records service that keeps each cause. */
const fixture = Effect.gen(function* () {
	// A logger runs outside of Effect, so it keeps its lines in a plain list.
	const lines: Array<Line> = []
	const saved = yield* Ref.make<ReadonlyArray<Cause.Cause<unknown>>>([])
	const logger = Logger.make((options) => {
		lines.push({
			message: Arr.isArray(options.message)
				? options.message
				: [options.message],
			cause: options.cause,
			annotations: options.fiber.getRef(References.CurrentLogAnnotations),
		})
	})
	const records = Layer.succeed(Records, {
		record: (cause, category) =>
			Effect.map(Ref.updateAndGet(saved, Arr.append(cause)), (all) => ({
				errorId: Execution.ErrorId.make(`error-${all.length}`),
				category,
			})),
	})
	const layer = Graft.layer.pipe(
		Layer.provideMerge(PluginLogs.layer),
		Layer.provideMerge(records),
		Layer.provideMerge(Logger.layer([logger])),
	)
	return { lines, saved, layer }
})

const broken = Feature.make("broken").start({
	inject: [],
	layer: Layer.effectDiscard(Effect.fail("A secret detail of the failure.")),
})

const hasCauseText = (line: Line) =>
	line.cause.reasons.length > 0 ||
	Arr.some(line.message, (part) => Str.includes("secret detail")(String(part)))

it.effect("a failed plugin gets one record and one log line with its id", () =>
	Effect.gen(function* () {
		const { lines, saved, layer } = yield* fixture
		yield* Effect.gen(function* () {
			const failures = yield* PluginFailures.make
			const fork = yield* Graft.plugin(broken)
			yield* fork.state.pipe(
				Stream.filter((state) => state._tag === "Failed"),
				Stream.runHead,
			)
			const first = yield* failures.flush
			assert.deepStrictEqual(Arr.fromIterable(first), [[fork.id, "error-1"]])
			// The retry fails with a new cause. It is the same failed time, so no new record.
			yield* TestClock.adjust("1 second")
			yield* fork.state.pipe(
				Stream.filter((state) => state._tag === "Failed"),
				Stream.runHead,
			)
			yield* failures.flush
			assert.strictEqual((yield* Ref.get(saved)).length, 1)
		}).pipe(Effect.scoped, Effect.provide(layer))
		const reported = Arr.filter(
			lines,
			(line) => line.message[0] === "A plugin failed.",
		)
		assert.strictEqual(reported.length, 1)
		assert.strictEqual(reported[0]?.annotations["errorId"], "error-1")
		assert.strictEqual(reported[0]?.annotations["plugin"], "broken")
		// No line shows the cause, also the lines that graft writes itself.
		assert.isFalse(Arr.some(lines, hasCauseText))
		// graft did log the failure, with the cause hidden.
		assert.isTrue(
			Arr.some(
				lines,
				(line) =>
					line.annotations["graft.plugin"] === "broken" &&
					Redacted.isRedacted(line.message[line.message.length - 1]),
			),
		)
	}),
)

it.effect("a line from a plugin fork gets its cause as a redacted value", () =>
	Effect.gen(function* () {
		const { lines, layer } = yield* fixture
		const cause = Cause.fail("A secret detail of the failure.")
		yield* Effect.gen(function* () {
			yield* Effect.logError("From a plugin.", cause).pipe(
				Effect.annotateLogs({ "graft.fork": 3 }),
			)
			yield* Effect.logError("From the loader.", cause).pipe(
				Effect.annotateLogs({ "loader.entry": "bots" }),
			)
			yield* Effect.logError("From the host.", cause)
		}).pipe(Effect.scoped, Effect.provide(layer))
		const [plugin, loader, host] = lines
		for (const line of [plugin, loader]) {
			assert.strictEqual(line?.cause.reasons.length, 0)
			const last = line?.message[line.message.length - 1]
			assert.isTrue(Redacted.isRedacted(last))
			assert.strictEqual(String(last), "<redacted>")
		}
		// A line from outside of graft keeps its cause, as before.
		assert.strictEqual(host?.cause, cause)
	}),
)

it.effect("a hidden cause that no failed fork keeps gets its own record", () =>
	Effect.gen(function* () {
		const { lines, saved, layer } = yield* fixture
		const cause = Cause.fail("A secret detail of the failure.")
		yield* Effect.gen(function* () {
			// The loader writes this line from its fork, and no fork fails.
			yield* Effect.logError("Reconciling loader entries failed", cause).pipe(
				Effect.annotateLogs({ "graft.fork": 2, "graft.plugin": "loader" }),
			)
			// PluginFailures saves this one from the Failed state of the fork.
			yield* Effect.logError('Plugin "broken" failed', cause).pipe(
				Effect.annotateLogs({ "graft.fork": 3, "graft.plugin": "broken" }),
			)
		}).pipe(Effect.scoped, Effect.provide(layer))
		assert.deepStrictEqual(yield* Ref.get(saved), [cause])
		const reported = Arr.filter(
			lines,
			(line) => line.annotations["errorId"] === "error-1",
		)
		assert.strictEqual(reported.length, 1)
		assert.strictEqual(reported[0]?.annotations["graft.fork"], 2)
		assert.isFalse(Arr.some(lines, hasCauseText))
	}),
)
