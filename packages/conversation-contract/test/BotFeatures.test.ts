import { assert, it } from "@effect/vitest"
import {
	Array as Arr,
	Context,
	Effect,
	Exit,
	Fiber,
	Layer,
	Ref,
	Schema,
	Scope,
} from "effect"
import { TestClock } from "effect/testing"
import {
	BotFeatures,
	type Contribution,
	DuplicateFeature,
	FeatureMissing,
	FeatureVersionChanged,
	layer,
	make,
	type Missing,
	type Pin,
	skip,
	wait,
} from "@openbot-build/conversation-contract/chats/BotFeatures"

const feature = (
	id: string,
	options: {
		readonly order?: number
		readonly version?: number
		readonly settings?: Effect.Effect<Schema.Json>
		readonly missing?: Missing
	} = {},
): Contribution => ({
	id,
	version: options.version ?? 1,
	order: options.order ?? 10,
	build: "normal",
	review: true,
	restores: [],
	missing: options.missing ?? wait(),
	settings: options.settings ?? Effect.succeed(null),
	prepare: () =>
		Effect.succeed({
			register: () => Effect.succeed({ tools: {}, handlers: Context.empty() }),
		}),
})

/** Adds a feature in its own scope, so the test can take it away. */
const contributeIn = (contribution: Contribution) =>
	Effect.gen(function* () {
		const features = yield* BotFeatures
		const scope = yield* Scope.make()
		yield* features.contribute(contribution).pipe(Scope.provide(scope))
		return scope
	})

/** A pin of version 1 with no settings. */
const pin = (id: string, missing: Missing = wait()): Pin => ({
	id,
	version: 1,
	settings: null,
	missing,
})

const ids = (held: ReadonlyArray<{ readonly contribution: Contribution }>) =>
	Arr.map(held, (entry) => entry.contribution.id)

it.effect(
	"a second feature with the same id fails with DuplicateBotFeature",
	() =>
		Effect.gen(function* () {
			const features = yield* BotFeatures
			yield* features.contribute(feature("same"))
			const failure = yield* features
				.contribute(feature("same", { order: 20 }))
				.pipe(Effect.flip)
			assert.ok(Schema.is(DuplicateFeature)(failure))
			assert.strictEqual(failure.id, "same")
		}).pipe(Effect.scoped, Effect.provide(layer)),
)

it.effect(
	"two layers with the same feature id stop the start with a defect",
	() =>
		Effect.gen(function* () {
			const contributeLayer = () =>
				Layer.effectDiscard(
					Effect.gen(function* () {
						const features = yield* BotFeatures
						yield* features.contribute(feature("same"))
					}),
				)
			// Two layer values, so the layers are not shared.
			const features = Layer.mergeAll(
				contributeLayer(),
				contributeLayer(),
			).pipe(Layer.orDie, Layer.provide(layer))
			const exit = yield* Layer.build(features).pipe(Effect.scoped, Effect.exit)
			assert.ok(Exit.isFailure(exit))
			assert.ok(Exit.hasDies(exit))
		}),
)

it.effect(
	"snapshot lists the present features in merge order, with their settings now",
	() =>
		Effect.gen(function* () {
			const features = yield* BotFeatures
			const limit = yield* Ref.make(1)
			yield* features.contribute(feature("late", { order: 50 }))
			yield* features.contribute(
				feature("early", {
					order: 10,
					version: 2,
					settings: Effect.map(Ref.get(limit), (value) => ({ limit: value })),
				}),
			)
			yield* features.contribute(feature("b-middle", { order: 30 }))
			yield* features.contribute(
				feature("a-middle", { order: 30, missing: skip }),
			)
			yield* Ref.set(limit, 5)
			assert.deepStrictEqual(yield* features.snapshot, [
				{
					id: "early",
					version: 2,
					settings: { limit: 5 },
					missing: { _tag: "wait", millis: 30_000 },
				},
				pin("a-middle", skip),
				pin("b-middle"),
				pin("late"),
			])
		}).pipe(Effect.scoped, Effect.provide(layer)),
)

it.effect(
	"a hold with the pinned versions gives the features in merge order with the pinned settings",
	() =>
		Effect.gen(function* () {
			const features = yield* BotFeatures
			const limit = yield* Ref.make(1)
			yield* features.contribute(feature("second", { order: 20 }))
			yield* features.contribute(
				feature("first", {
					order: 10,
					settings: Effect.map(Ref.get(limit), (value) => ({ limit: value })),
				}),
			)
			const pins = yield* features.snapshot
			yield* Ref.set(limit, 9)
			const held = yield* features.hold(Arr.reverse(pins))
			assert.deepStrictEqual(ids(held), ["first", "second"])
			assert.deepStrictEqual(held[0]?.pin.settings, { limit: 1 })
		}).pipe(Effect.scoped, Effect.provide(layer)),
)

it.effect(
	"a hold fails with BotFeatureVersionChanged when a pinned feature has a new version",
	() =>
		Effect.gen(function* () {
			const features = yield* BotFeatures
			yield* features.contribute(feature("tools", { version: 2 }))
			const failure = yield* features.hold([pin("tools")]).pipe(Effect.flip)
			assert.ok(Schema.is(FeatureVersionChanged)(failure))
			assert.deepStrictEqual(
				{
					id: failure.id,
					pinned: failure.pinned,
					present: failure.present,
				},
				{ id: "tools", pinned: 1, present: 2 },
			)
		}).pipe(Effect.scoped, Effect.provide(layer)),
)

it.effect(
	"a hold waits for an absent feature, then holds it when it comes back",
	() =>
		Effect.gen(function* () {
			const features = yield* BotFeatures
			const waiting = yield* features
				.hold([pin("later")])
				.pipe(Effect.forkScoped)
			yield* Effect.yieldNow
			assert.isUndefined(waiting.pollUnsafe())
			yield* features.contribute(feature("later"))
			const held = yield* Fiber.join(waiting)
			assert.deepStrictEqual(ids(held), ["later"])
		}).pipe(Effect.scoped, Effect.provide(layer)),
)

it.effect(
	"a hold fails with BotFeatureMissing when an absent feature does not come back in time",
	() =>
		Effect.gen(function* () {
			const features = yield* BotFeatures
			yield* features.contribute(feature("present"))
			const waiting = yield* features
				.hold([pin("present"), pin("gone", wait("10 seconds"))])
				.pipe(Effect.flip, Effect.forkScoped)
			yield* TestClock.adjust("9 seconds")
			assert.isUndefined(waiting.pollUnsafe())
			yield* TestClock.adjust("1 second")
			const failure = yield* Fiber.join(waiting)
			assert.ok(Schema.is(FeatureMissing)(failure))
			assert.deepStrictEqual(failure.ids, ["gone"])
			// The wait held nothing.
			assert.deepStrictEqual(ids(yield* features.holdPresent), ["present"])
		}).pipe(Effect.scoped, Effect.provide(layer)),
)

it.effect(
	"a hold leaves out an absent feature whose pin says skip, and holds the others",
	() =>
		Effect.gen(function* () {
			const features = yield* BotFeatures
			yield* features.contribute(feature("tools"))
			const held = yield* features.hold([pin("limit", skip), pin("tools")])
			assert.deepStrictEqual(ids(held), ["tools"])
			// A pin with skip still holds its feature when it is there.
			yield* features.contribute(feature("limit", { order: 5, missing: skip }))
			assert.deepStrictEqual(
				ids(yield* features.hold([pin("limit", skip), pin("tools")])),
				["limit", "tools"],
			)
		}).pipe(Effect.scoped, Effect.provide(layer)),
)

it.effect(
	"the policy of the pin counts, not the policy of the feature that is there now",
	() =>
		Effect.gen(function* () {
			const features = yield* BotFeatures
			// The feature now says skip, but the Turn pinned it with wait.
			const scope = yield* contributeIn(feature("tools", { missing: skip }))
			yield* Scope.close(scope, Exit.void)
			const failure = yield* features
				.hold([pin("tools", wait("1 second"))])
				.pipe(Effect.flip, Effect.forkScoped)
			yield* TestClock.adjust("1 second")
			assert.ok(Schema.is(FeatureMissing)(yield* Fiber.join(failure)))
		}).pipe(Effect.scoped, Effect.provide(layer)),
)

it.effect("a hold that waits takes no lease", () =>
	Effect.gen(function* () {
		const features = yield* make({ drain: "30 seconds" })
		const scope = yield* Scope.make()
		yield* features.contribute(feature("present")).pipe(Scope.provide(scope))
		const waiting = yield* features
			.hold([pin("absent"), pin("present")])
			.pipe(Effect.forkScoped)
		yield* Effect.yieldNow
		// No clock moves: the release must not wait for the hold that waits.
		yield* Scope.close(scope, Exit.void)
		assert.isUndefined(waiting.pollUnsafe())
		yield* Fiber.interrupt(waiting)
	}).pipe(Effect.scoped),
)

it.effect("a released feature leaves new holds at once", () =>
	Effect.gen(function* () {
		const features = yield* BotFeatures
		yield* features.contribute(feature("kept"))
		const scope = yield* contributeIn(feature("gone", { order: 20 }))
		yield* Scope.close(scope, Exit.void)
		assert.deepStrictEqual(ids(yield* features.holdPresent), ["kept"])
		assert.deepStrictEqual(
			Arr.map(yield* features.snapshot, (pin) => pin.id),
			["kept"],
		)
	}).pipe(Effect.scoped, Effect.provide(layer)),
)

it.effect("a feature that a hold did not pin is not given", () =>
	Effect.gen(function* () {
		const features = yield* BotFeatures
		yield* features.contribute(feature("pinned"))
		const pins = yield* features.snapshot
		yield* features.contribute(feature("new", { order: 5 }))
		assert.deepStrictEqual(ids(yield* features.hold(pins)), ["pinned"])
	}).pipe(Effect.scoped, Effect.provide(layer)),
)

it.effect(
	"with a drain time, a release waits for its holders, and stops after the drain time",
	() =>
		Effect.gen(function* () {
			const features = yield* make({ drain: "30 seconds" })
			const contribution = yield* Scope.make()
			yield* features
				.contribute(feature("held"))
				.pipe(Scope.provide(contribution))
			const holder = yield* Scope.make()
			yield* features.holdPresent.pipe(Scope.provide(holder))
			const release = yield* Scope.close(contribution, Exit.void).pipe(
				Effect.forkScoped,
			)
			yield* Effect.yieldNow
			assert.isUndefined(release.pollUnsafe())
			assert.deepStrictEqual(yield* features.snapshot, [])
			yield* TestClock.adjust("30 seconds")
			yield* Fiber.join(release)
			yield* Scope.close(holder, Exit.void)
		}).pipe(Effect.scoped),
)

it.effect("a release waits only until the last holder leaves", () =>
	Effect.gen(function* () {
		const features = yield* make({ drain: "30 seconds" })
		const contribution = yield* Scope.make()
		yield* features
			.contribute(feature("held"))
			.pipe(Scope.provide(contribution))
		const first = yield* Scope.make()
		const second = yield* Scope.make()
		yield* features.holdPresent.pipe(Scope.provide(first))
		yield* features.hold([pin("held")]).pipe(Scope.provide(second))
		const release = yield* Scope.close(contribution, Exit.void).pipe(
			Effect.forkScoped,
		)
		yield* Effect.yieldNow
		yield* Scope.close(first, Exit.void)
		yield* Effect.yieldNow
		assert.isUndefined(release.pollUnsafe())
		yield* Scope.close(second, Exit.void)
		yield* Fiber.join(release)
	}).pipe(Effect.scoped),
)
