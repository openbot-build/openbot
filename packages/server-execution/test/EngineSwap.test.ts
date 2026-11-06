import { assert, it } from "@effect/vitest"
import {
	Array as Arr,
	Effect,
	Exit,
	Fiber,
	HashMap,
	Option,
	Order,
	Ref,
	Scope,
	String as Str,
} from "effect"
import { TestClock } from "effect/testing"
import * as Engine from "@openbot-build/server-execution/Engine"
import * as EngineHost from "@openbot-build/server-execution/EngineHost"
import * as Workflows from "@openbot-build/server-execution/Workflows"

const open = Workflows.Policy.Public({ authorize: () => Effect.void })

/** Lets the other fibers run until the check gives a value. */
const until = <A, E, R>(check: Effect.Effect<Option.Option<A>, E, R>) =>
	Effect.gen(function* () {
		for (let round = 0; round < 10_000; round++) {
			const found = yield* check
			if (Option.isSome(found)) return found.value
			yield* Effect.yieldNow
		}
		return yield* Effect.die("The check did not pass.")
	})

/** Lets the other fibers run for a while. */
const settle = Effect.gen(function* () {
	for (let round = 0; round < 200; round++) yield* Effect.yieldNow
})

/**
 * A swap whose generations only write what they do. A generation notes the
 * workflows it hosts when it opens, and notes when it closes. `most` is the
 * largest number of generations that were open at one time.
 */
const harness = Effect.gen(function* () {
	const workflows = yield* Workflows.Workflows
	const events = yield* Ref.make<ReadonlyArray<string>>([])
	const live = yield* Ref.make(0)
	const most = yield* Ref.make(0)
	const count = yield* Ref.make(0)
	const generation = (
		hosted: HashMap.HashMap<string, Workflows.Contribution>,
	) =>
		Effect.gen(function* () {
			const number = yield* Ref.updateAndGet(count, (n) => n + 1)
			const now = yield* Ref.updateAndGet(live, (n) => n + 1)
			yield* Ref.update(most, (before) => Math.max(before, now))
			const names = Arr.join(
				Arr.sort(Arr.fromIterable(HashMap.keys(hosted)), Order.String),
				",",
			)
			yield* Ref.update(events, Arr.append(`open ${number} ${names}`))
			yield* Effect.addFinalizer(() =>
				Ref.update(live, (n) => n - 1).pipe(
					Effect.andThen(Ref.update(events, Arr.append(`close ${number}`))),
				),
			)
		})
	yield* EngineHost.swap({
		changes: workflows.changes,
		current: workflows.current,
		open: Effect.tap(workflows.acquire, generation),
		stable: Effect.void,
		delay: EngineHost.swapDelay,
		failed: () => Effect.void,
	})
	return { events, most, live }
})

/** Adds a workflow in its own scope, so the test can take it away. */
const contribute = (name: string) =>
	Effect.gen(function* () {
		const workflows = yield* Workflows.Workflows
		const scope = yield* Scope.make()
		yield* workflows
			.contribute({
				workflow: Engine.define(name),
				plugin: "test",
				journal: 1,
				run: () => Effect.void,
				policy: open,
			})
			.pipe(Scope.provide(scope), Effect.orDie)
		return scope
	})

const run = <A, E>(
	effect: Effect.Effect<A, E, Workflows.Workflows | Scope.Scope>,
) => effect.pipe(Effect.scoped, Effect.provide(Workflows.layer))

it.effect("the first generation opens at once", () =>
	run(
		Effect.gen(function* () {
			yield* contribute("first")
			const { events } = yield* harness
			assert.deepStrictEqual(yield* Ref.get(events), ["open 1 first"])
		}),
	),
)

it.effect("a removal closes the generation at once and waits for it", () =>
	run(
		Effect.gen(function* () {
			const first = yield* contribute("first")
			yield* contribute("second")
			const { events } = yield* harness
			const removal = yield* Scope.close(first, Exit.void).pipe(
				Effect.andThen(Ref.update(events, Arr.append("removed"))),
				Effect.forkChild,
			)
			yield* Fiber.join(removal)
			// The removal ends after the close, with no time going by.
			assert.deepStrictEqual(yield* Ref.get(events), [
				"open 1 first,second",
				"close 1",
				"removed",
			])
			yield* TestClock.adjust(EngineHost.swapDelay)
			yield* until(
				Effect.map(Ref.get(events), (list) =>
					Option.liftPredicate(list, (list) => list.length === 4),
				),
			)
			assert.deepStrictEqual(
				Arr.last(yield* Ref.get(events)),
				Option.some("open 2 second"),
			)
		}),
	),
)

it.effect("an addition waits for the plugins to settle and the delay", () =>
	run(
		Effect.gen(function* () {
			yield* contribute("first")
			const { events } = yield* harness
			yield* contribute("second")
			yield* settle
			assert.deepStrictEqual(yield* Ref.get(events), ["open 1 first"])
			yield* TestClock.adjust("999 millis")
			yield* settle
			assert.deepStrictEqual(yield* Ref.get(events), ["open 1 first"])
			yield* TestClock.adjust("1 millis")
			yield* until(
				Effect.map(Ref.get(events), (list) =>
					Option.liftPredicate(list, (list) => list.length === 3),
				),
			)
			assert.deepStrictEqual(yield* Ref.get(events), [
				"open 1 first",
				"close 1",
				"open 2 first,second",
			])
		}),
	),
)

it.effect("the swap opens nothing when no workflow is in", () =>
	run(
		Effect.gen(function* () {
			const first = yield* contribute("first")
			const { events, live } = yield* harness
			yield* Scope.close(first, Exit.void)
			yield* TestClock.adjust("5 seconds")
			yield* settle
			assert.deepStrictEqual(yield* Ref.get(events), [
				"open 1 first",
				"close 1",
			])
			assert.strictEqual(yield* Ref.get(live), 0)
		}),
	),
)

it.effect("at most one generation is open over many changes", () =>
	run(
		Effect.gen(function* () {
			const { most, live, events } = yield* harness
			let scopes = HashMap.empty<string, Scope.Closeable>()
			// A fixed list of steps keeps the test the same on each run.
			let seed = 7
			const next = (limit: number) => {
				seed = (seed * 1103515245 + 12345) % 2147483648
				return seed % limit
			}
			for (let step = 0; step < 20; step++) {
				const names = Arr.fromIterable(HashMap.keys(scopes))
				if (names.length > 0 && next(2) === 0) {
					const name = names[next(names.length)]!
					yield* Scope.close(HashMap.getUnsafe(scopes, name), Exit.void)
					scopes = HashMap.remove(scopes, name)
				} else {
					const name = `step-${step}`
					scopes = HashMap.set(scopes, name, yield* contribute(name))
				}
				yield* TestClock.adjust(`${next(1500)} millis`)
				yield* settle
				assert.isAtMost(yield* Ref.get(live), 1)
			}
			yield* TestClock.adjust("2 seconds")
			yield* settle
			assert.strictEqual(yield* Ref.get(most), 1)
			const wanted = Arr.join(
				Arr.sort(Arr.fromIterable(HashMap.keys(scopes)), Order.String),
				",",
			)
			const last = Arr.findLast(yield* Ref.get(events), (event) =>
				Str.startsWith("open")(event),
			)
			assert.isTrue(
				wanted === "" ||
					Option.exists(last, (event) => Str.endsWith(` ${wanted}`)(event)),
			)
		}),
	),
)
