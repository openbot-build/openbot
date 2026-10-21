import assert from "node:assert/strict"
import { test } from "node:test"
import { Data, Effect, Option } from "effect"
import { replaceDrained } from "../src/app/Supervisor.ts"
import * as InstanceWork from "../src/execution/InstanceWork.ts"

class FixtureFailure extends Data.TaggedError("FixtureFailure")<{}> {}

test("settings reload defers active or uninspectable work and stops before starting", async () => {
	const events: string[] = []
	const old = { id: "old" }
	const next = { id: "new" }
	const input = {
		current: old,
		stop: () =>
			Effect.sync(() => {
				events.push("stop")
			}),
		start: Effect.sync(() => {
			events.push("start")
			return next
		}),
	}
	for (const idle of [
		Effect.succeed(false),
		Effect.fail(new FixtureFailure()),
	]) {
		assert.deepEqual(
			await Effect.runPromise(replaceDrained({ ...input, idle })),
			Option.some(old),
		)
		assert.deepEqual(events, [])
	}
	assert.deepEqual(
		await Effect.runPromise(
			replaceDrained({ ...input, idle: Effect.succeed(true) }),
		),
		Option.some(next),
	)
	assert.deepEqual(events, ["stop", "start"])
})

test("failed replacement never returns the stopped executor", async () => {
	let stops = 0
	const result = await Effect.runPromise(
		replaceDrained({
			current: "old",
			idle: Effect.succeed(true),
			stop: () =>
				Effect.sync(() => {
					stops++
				}),
			start: Effect.fail(new FixtureFailure()),
		}),
	)
	assert.equal(stops, 1)
	assert.ok(Option.isNone(result))
})

test("settings pause blocks new tasks without clearing an operator pause", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const work = yield* InstanceWork.make
			const task = yield* work.reserve
			const release = yield* work.pause
			assert.equal((yield* work.status).activeTasks, 1)
			assert.ok(Option.isNone(yield* work.reserve.pipe(Effect.option)))
			yield* work.quiesce
			yield* task.release
			yield* release
			assert.equal((yield* work.status).quiesced, true)
			yield* work.resume
			assert.equal((yield* work.status).quiesced, false)
		}),
	)
})
