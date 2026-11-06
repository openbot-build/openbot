import { ServiceId } from "@openbot-build/domain/Identity"
import { assert, it } from "@effect/vitest"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Deferred,
	Effect,
	Exit,
	Fiber,
	HashMap,
	Option,
	Schema,
	Scope,
} from "effect"
import * as Engine from "@openbot-build/server-execution/Engine"
import {
	Duplicate,
	Policy,
	Unavailable,
	Workflows,
	layer,
} from "@openbot-build/server-execution/Workflows"

const key = { namespace: "test", id: Execution.Id.make("work") }
const member = {
	kind: "member",
	organizationId: "org",
	userId: "user",
} as const

const contribution = (name: string, plugin = "test") => ({
	workflow: Engine.define(name),
	plugin,
	journal: 1,
	run: () => Effect.void,
	policy: Policy.Public({ authorize: () => Effect.void }),
})

it.effect(
	"a second contribution with the same name fails with ExecutionWorkflowDuplicate",
	() =>
		Effect.gen(function* () {
			const workflows = yield* Workflows
			yield* workflows.contribute(contribution("same", "first"))
			const failure = yield* workflows
				.contribute(contribution("same", "second"))
				.pipe(Effect.flip)
			assert.ok(Schema.is(Duplicate)(failure))
			assert.strictEqual(failure.plugin, "second")
			assert.strictEqual(failure.other, "first")
		}).pipe(Effect.provide(layer)),
)

it.effect("a closed contribution scope removes the policy at once", () =>
	Effect.gen(function* () {
		const workflows = yield* Workflows
		const scope = yield* Scope.make()
		yield* workflows
			.contribute(contribution("removed", "chats"))
			.pipe(Scope.provide(scope))
		const found = yield* workflows.get("removed")
		assert.ok(Option.isSome(found))
		yield* Option.getOrThrow(found).authorize(key, member, "read")
		yield* Scope.close(scope, Exit.void)
		assert.ok(Option.isNone(yield* workflows.get("removed")))
		assert.deepStrictEqual(yield* workflows.names, [])
		const failure = yield* workflows.require("removed").pipe(Effect.flip)
		assert.ok(Schema.is(Unavailable)(failure))
		assert.deepStrictEqual(
			{ workflow: failure.workflow, feature: failure.feature },
			{ workflow: "removed", feature: "chats" },
		)
	}).pipe(Effect.provide(layer)),
)

it.effect("Unavailable names the workflow when no plugin ever gave it", () =>
	Effect.gen(function* () {
		const workflows = yield* Workflows
		const failure = yield* workflows.require("never").pipe(Effect.flip)
		assert.deepStrictEqual(
			{ workflow: failure.workflow, feature: failure.feature },
			{ workflow: "never", feature: "never" },
		)
	}).pipe(Effect.provide(layer)),
)

it.effect("a public policy turns down a service caller", () =>
	Effect.gen(function* () {
		const workflows = yield* Workflows
		yield* workflows.contribute(contribution("public"))
		const found = Option.getOrThrow(yield* workflows.get("public"))
		const failure = yield* found
			.authorize(
				key,
				{ kind: "service", serviceId: ServiceId.make("index") },
				"read",
			)
			.pipe(Effect.flip)
		assert.ok(Schema.is(Execution.Forbidden)(failure))
	}).pipe(Effect.provide(layer)),
)

it.effect("release waits while a generation holds the name", () =>
	Effect.gen(function* () {
		const workflows = yield* Workflows
		const feature = yield* Scope.make()
		const generation = yield* Scope.make()
		yield* workflows
			.contribute(contribution("held"))
			.pipe(Scope.provide(feature))
		yield* workflows.hold(["held"]).pipe(Scope.provide(generation))
		const started = yield* Deferred.make<void>()
		const release = yield* Deferred.succeed(started, undefined).pipe(
			Effect.andThen(Scope.close(feature, Exit.void)),
			Effect.forkChild,
		)
		yield* Deferred.await(started)
		// The policy goes at once, but the release waits for the generation.
		yield* Effect.yieldNow
		assert.ok(Option.isNone(yield* workflows.get("held")))
		assert.strictEqual(release.pollUnsafe(), undefined)
		yield* Scope.close(generation, Exit.void)
		yield* Fiber.join(release)
	}).pipe(Effect.provide(layer)),
)

it.effect("a contribution after seal dies", () =>
	Effect.gen(function* () {
		const workflows = yield* Workflows
		yield* workflows.contribute(contribution("early"))
		const sealed = yield* workflows.seal
		assert.deepStrictEqual(Arr.fromIterable(HashMap.keys(sealed)), ["early"])
		const exit = yield* workflows
			.contribute(contribution("late"))
			.pipe(Effect.exit)
		assert.ok(Exit.hasDies(exit))
	}).pipe(Effect.provide(layer)),
)
