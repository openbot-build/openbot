import { assert, it } from "@effect/vitest"
import { type Fork, Graft, Plugin as GraftPlugin } from "@graftland/graft"
import {
	Array as Arr,
	Context,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Ref,
	Scope,
	Stream,
} from "effect"
import { TestClock } from "effect/testing"
import * as Feature from "@openbot-build/server-plugin/Feature"

class First extends Context.Service<First, { readonly value: string }>()(
	"@openbot-build/server-plugin/test/Feature.test/First",
) {}
class Second extends Context.Service<Second, { readonly value: string }>()(
	"@openbot-build/server-plugin/test/Feature.test/Second",
) {}
class Missing extends Context.Service<Missing, { readonly value: string }>()(
	"@openbot-build/server-plugin/test/Feature.test/Missing",
) {}

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

/** The first state of the fork with this tag. */
const reach = (fork: Fork.Fork, tag: Fork.ForkState["_tag"]) =>
	fork.state.pipe(
		Stream.filter((state) => state._tag === tag),
		Stream.runHead,
		Effect.map(Option.getOrThrow),
	)

/** The fork with this name, as it is now. */
const forkNamed = (name: string) =>
	Effect.map(Stream.runHead(Graft.forks), (trees) => {
		const all = (
			list: ReadonlyArray<Fork.ForkTree>,
		): ReadonlyArray<Fork.ForkTree> =>
			Arr.flatMap(list, (tree) => [tree, ...all(tree.children)])
		return Arr.findFirst(
			all(Option.getOrElse(trees, () => [])),
			(tree) => tree.name === name,
		)
	})

const stateOf = (name: string) =>
	Effect.map(
		forkNamed(name),
		Option.map((tree) => tree.state._tag),
	)

/** A plugin that waits for `First` and keeps the value it sees. */
const reader = (seen: Ref.Ref<Option.Option<string>>) =>
	Feature.make("reader").start({
		inject: [First],
		layer: Layer.effectDiscard(
			Effect.flatMap(First, (first) => Ref.set(seen, Option.some(first.value))),
		),
	})

const inGraft = <A, E>(
	effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>,
) => effect.pipe(Effect.scoped, Effect.provide(Graft.layer))

it.effect("a consumer sees a service only after its build ends", () =>
	inGraft(
		Effect.gen(function* () {
			const seen = yield* Ref.make(Option.none<string>())
			const consumer = yield* Graft.plugin(reader(seen))
			yield* Graft.plugin(
				Feature.make("slow")
					.stage({
						inject: [],
						services: Layer.effect(
							First,
							Effect.as(Effect.sleep("1 second"), { value: "first" }),
						),
						publishes: [First],
					})
					.start({ inject: [], layer: Layer.empty }),
			)
			yield* reach(consumer, "Pending")
			yield* TestClock.adjust("500 millis")
			assert.isTrue(Option.isNone(yield* Ref.get(seen)))
			yield* TestClock.adjust("500 millis")
			yield* reach(consumer, "Active")
			assert.deepStrictEqual(yield* Ref.get(seen), Option.some("first"))
		}),
	),
)

it.effect("a stage publishes all of its keys in one step", () =>
	inGraft(
		Effect.gen(function* () {
			const consumer = yield* Graft.plugin(
				Feature.make("both").start({
					inject: [First, Second],
					layer: Layer.empty,
				}),
			)
			const states = yield* consumer.state.pipe(
				Stream.takeUntil((state) => state._tag === "Active"),
				Stream.runCollect,
				Effect.forkChild,
			)
			yield* reach(consumer, "Pending")
			yield* Graft.plugin(
				Feature.make("pair")
					.stage({
						inject: [],
						services: Layer.merge(
							Layer.succeed(First, { value: "first" }),
							Layer.succeed(Second, { value: "second" }),
						),
						publishes: [First, Second],
					})
					.start({ inject: [], layer: Layer.empty }),
			)
			const seen = yield* Fiber.join(states)
			// The consumer never waits for only one of the two keys.
			assert.isTrue(
				Arr.every(
					seen,
					(state) => state._tag !== "Pending" || state.missing.length === 2,
				),
			)
			assert.deepStrictEqual(
				Option.map(Arr.last(seen), (state) => state._tag),
				Option.some("Active"),
			)
		}),
	),
)

it.effect("a start that waits for a key does not hold back the stage", () =>
	inGraft(
		Effect.gen(function* () {
			const seen = yield* Ref.make(Option.none<string>())
			yield* Graft.plugin(
				Feature.make("early")
					.stage({
						inject: [],
						services: Layer.succeed(First, { value: "first" }),
						publishes: [First],
					})
					.start({ inject: [Missing], layer: Layer.empty }),
			)
			const consumer = yield* Graft.plugin(reader(seen))
			yield* reach(consumer, "Active")
			assert.deepStrictEqual(yield* Ref.get(seen), Option.some("first"))
			assert.deepStrictEqual(yield* until(stateOf("early#start")), "Pending")
		}),
	),
)

it.effect("a missing key makes the fork pending, not failed", () =>
	inGraft(
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(
				Feature.make("waiting").start({
					inject: [Missing],
					layer: Layer.empty,
				}),
			)
			const state = yield* reach(fork, "Pending")
			assert.deepStrictEqual(state._tag === "Pending" ? state.missing : [], [
				"@openbot-build/server-plugin/test/Feature.test/Missing",
			])
		}),
	),
)

it.effect("the start closes before the services of the stage", () =>
	Effect.gen(function* () {
		const events = yield* Ref.make<ReadonlyArray<string>>([])
		const note = (event: string) => Ref.update(events, Arr.append(event))
		const scope = yield* Scope.make()
		const fork = yield* Graft.plugin(
			Feature.make("ordered")
				.stage({
					inject: [],
					services: Layer.effect(
						First,
						Effect.as(
							Effect.addFinalizer(() => note("services closed")),
							{ value: "first" },
						),
					),
					publishes: [First],
				})
				.start({
					inject: [],
					layer: Layer.effectDiscard(
						Effect.addFinalizer(() => note("start closed")),
					),
				}),
		).pipe(Scope.provide(scope))
		yield* reach(fork, "Active")
		yield* until(
			Effect.map(stateOf("ordered#start"), (state) =>
				Option.filter(state, (tag) => tag === "Active"),
			),
		)
		yield* Scope.close(scope, Exit.void)
		assert.deepStrictEqual(yield* Ref.get(events), [
			"start closed",
			"services closed",
		])
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect("a failed stage tries again on the retry schedule", () =>
	inGraft(
		Effect.gen(function* () {
			const attempts = yield* Ref.make(0)
			const fork = yield* Graft.plugin(
				Feature.make("flaky")
					.stage({
						inject: [],
						services: Layer.effect(
							First,
							Effect.flatMap(
								Ref.updateAndGet(attempts, (n) => n + 1),
								(attempt) =>
									attempt === 1
										? Effect.fail("The first build fails.")
										: Effect.succeed({ value: "first" }),
							),
						),
						publishes: [First],
					})
					.start({ inject: [], layer: Layer.empty }),
			)
			yield* reach(fork, "Failed")
			yield* TestClock.adjust("1 second")
			yield* reach(fork, "Active")
			assert.strictEqual(yield* Ref.get(attempts), 2)
		}),
	),
)

it.effect("a stage that restarts does not restart its parent", () =>
	inGraft(
		Effect.gen(function* () {
			const builds = yield* Ref.make<ReadonlyArray<string>>([])
			const count = (stage: string) => Ref.update(builds, Arr.append(stage))
			const outside = yield* Graft.plugin(
				Feature.make("outside")
					.stage({
						inject: [],
						services: Layer.succeed(Second, { value: "second" }),
						publishes: [Second],
					})
					.start({ inject: [], layer: Layer.empty }),
			)
			yield* reach(outside, "Active")
			yield* Graft.plugin(
				Feature.make("chain")
					.stage({
						inject: [],
						services: Layer.effect(
							First,
							Effect.as(count("first"), { value: "first" }),
						),
						publishes: [First],
					})
					.stage({
						name: "later",
						inject: [Second],
						services: Layer.effect(
							Missing,
							Effect.as(count("later"), { value: "later" }),
						),
						publishes: [Missing],
					})
					.start({ inject: [], layer: Layer.empty }),
			)
			yield* until(
				Effect.map(Ref.get(builds), (list) =>
					Option.liftPredicate(list, (list) => list.length === 2),
				),
			)
			yield* outside.restart
			const after = yield* until(
				Effect.map(Ref.get(builds), (list) =>
					Option.liftPredicate(list, (list) => list.length === 3),
				),
			)
			assert.deepStrictEqual(after, ["first", "later", "later"])
		}),
	),
)

it("the types reject a wrong list of keys", () => {
	// A later step must not list a key that a stage gives already.
	const repeated = Feature.make("repeated")
		.stage({
			inject: [],
			services: Layer.succeed(First, { value: "first" }),
			publishes: [First],
		})
		.start({ inject: [First], layer: Layer.empty })
	assert.isTrue(GraftPlugin.isPlugin(repeated))
	// @ts-expect-error -- the builder gives `Broken`, which is not a feature
	const repeatedFeature: Feature.Feature<First> = repeated
	// A stage must publish every service that it builds.
	const partial = Feature.make("partial").stage({
		inject: [],
		services: Layer.merge(
			Layer.succeed(First, { value: "first" }),
			Layer.succeed(Second, { value: "second" }),
		),
		publishes: [First],
	})
	// @ts-expect-error -- `Broken` has no `start`
	const partialStart: unknown = partial.start
	// At run time the builder is the same. Only the types are different.
	assert.isDefined(repeatedFeature)
	assert.isFunction(partialStart)
})
