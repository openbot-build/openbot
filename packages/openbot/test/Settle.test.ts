import { assert, it } from "@effect/vitest"
import { Graft } from "@graftland/graft"
import {
	Array as Arr,
	Context,
	Effect,
	Exit,
	HashMap,
	Layer,
	Logger,
	References,
	Scope,
	String as Str,
} from "effect"
import { TestClock } from "effect/testing"
import * as Composition from "../src/app/Composition.ts"
import * as Feature from "@openbot-build/server-plugin/Feature"

class Given extends Context.Service<Given, { readonly value: string }>()(
	"@openbot-build/openbot/test/Settle.test/Given",
) {}
class Missing extends Context.Service<Missing, { readonly value: string }>()(
	"@openbot-build/openbot/test/Settle.test/Missing",
) {}

const provider = Feature.make("provider")
	.stage({
		inject: [],
		services: Layer.succeed(Given, { value: "given" }),
		publishes: [Given],
	})
	.start({ inject: [], layer: Layer.empty })

const broken = Feature.make("broken").start({
	inject: [],
	layer: Layer.effectDiscard(Effect.fail("The build is broken.")),
})

const waiting = Feature.make("waiting").start({
	inject: [Missing],
	layer: Layer.empty,
})

const options = {
	errors: Effect.succeed(HashMap.empty<number, string>()),
	quiet: "50 millis",
	timeout: "5 seconds",
} as const

const inGraft = <A, E>(
	effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>,
) => effect.pipe(Effect.scoped, Effect.provide(Graft.layer))

it.live("the gate opens when every fork below the roots is active", () =>
	inGraft(
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(provider)
			yield* Composition.settle({ ...options, roots: [fork.id] })
		}),
	),
)

it.live("a failed fork closes the gate with its error record", () =>
	inGraft(
		Effect.gen(function* () {
			const good = yield* Graft.plugin(provider)
			const bad = yield* Graft.plugin(broken)
			const exit = yield* Composition.settle({
				...options,
				roots: [good.id, bad.id],
				errors: Effect.succeed(HashMap.make([bad.id, "error-1"])),
			}).pipe(Effect.exit)
			assert.deepStrictEqual(
				exit,
				Exit.fail(
					Composition.PluginsInactive.make({
						forks: [
							{
								fork: bad.id,
								plugin: "broken",
								state: "Failed",
								missing: [],
								errorId: "error-1",
							},
						],
					}),
				),
			)
		}),
	),
)

it.live("a pending fork closes the gate with the keys it waits for", () =>
	inGraft(
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(waiting)
			const exit = yield* Composition.settle({
				...options,
				roots: [fork.id],
			}).pipe(Effect.exit)
			assert.deepStrictEqual(
				exit,
				Exit.fail(
					Composition.PluginsInactive.make({
						forks: [
							{
								fork: fork.id,
								plugin: "waiting",
								state: "Pending",
								missing: ["@openbot-build/openbot/test/Settle.test/Missing"],
							},
						],
					}),
				),
			)
		}),
	),
)

it.live("a fork that waits for a later provider does not close the gate", () =>
	inGraft(
		Effect.gen(function* () {
			const consumer = yield* Graft.plugin(
				Feature.make("consumer").start({ inject: [Given], layer: Layer.empty }),
			)
			// The provider comes after a short time, well inside the quiet time.
			const late = Effect.andThen(
				Effect.sleep("10 millis"),
				Graft.plugin(provider),
			)
			const [, fork] = yield* Effect.all(
				[
					Composition.settle({
						...options,
						quiet: "500 millis",
						roots: [consumer.id],
					}),
					late,
				],
				{ concurrency: "unbounded" },
			)
			assert.isAbove(fork.id, consumer.id)
		}),
	),
)

it.live("a root that is gone closes the gate", () =>
	inGraft(
		Effect.gen(function* () {
			const exit = yield* Composition.settle({ ...options, roots: [999] }).pipe(
				Effect.exit,
			)
			assert.isTrue(Exit.isFailure(exit))
		}),
	),
)

class Slow extends Context.Service<Slow, { readonly value: string }>()(
	"@openbot-build/openbot/test/Settle.test/Slow",
) {}

const slow = Feature.make("slow")
	.stage({
		inject: [],
		services: Layer.effect(Slow, Effect.never),
		publishes: [Slow],
	})
	.done()

it.effect(
	"the swap wait logs one warning that names a fork that keeps loading",
	() =>
		Effect.gen(function* () {
			// A logger runs outside of Effect, so it keeps its lines in a plain list.
			const lines: Array<{
				readonly message: unknown
				readonly annotations: Readonly<Record<string, unknown>>
				readonly cause: number
			}> = []
			const logger = Logger.make((line) => {
				lines.push({
					message: Arr.isArray(line.message) ? line.message[0] : line.message,
					annotations: line.fiber.getRef(References.CurrentLogAnnotations),
					cause: line.cause.reasons.length,
				})
			})
			yield* Effect.gen(function* () {
				const fork = yield* Graft.plugin(slow)
				const wait = yield* Effect.forkChild(Composition.stableOrWarn)
				yield* TestClock.adjust(Composition.startTimeout)
				yield* TestClock.adjust("1 second")
				yield* TestClock.adjust(Composition.startTimeout)
				const warnings = Arr.filter(lines, (line) =>
					Str.startsWith("Plugins are still loading")(String(line.message)),
				)
				assert.strictEqual(warnings.length, 1)
				assert.strictEqual(
					warnings[0]?.annotations["loading"],
					`slow (${fork.id})`,
				)
				assert.strictEqual(warnings[0]?.cause, 0)
				// The wait goes on while the fork loads.
				assert.isUndefined(wait.pollUnsafe())
			}).pipe(
				Effect.scoped,
				Effect.provide(Layer.merge(Graft.layer, Logger.layer([logger]))),
			)
		}),
)
