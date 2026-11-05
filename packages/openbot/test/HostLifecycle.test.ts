import { assert, layer } from "@effect/vitest"
import { Execution } from "@openbot-build/domain"
import { FailureApi } from "@openbot-build/api"
import {
	Array as Arr,
	Context,
	Deferred,
	Effect,
	Layer,
	Logger,
	Option,
	Ref,
	References,
	Stream,
} from "effect"
import { FetchHttpClient, HttpClient, HttpServer } from "effect/http"
import { SqlClient } from "effect/sql"
import * as Composition from "../src/app/Composition.ts"
import * as PresetPlugins from "../src/app/PresetPlugins.ts"
import * as Engine from "@openbot-build/server-execution/execution/Engine"
import * as Store from "@openbot-build/server-execution/execution/Store"
import * as Workflows from "@openbot-build/server-execution/execution/Workflows"
import * as Feature from "@openbot-build/server-plugin/Feature"
import * as TurnWorkflow from "../src/plugin-chats/TurnWorkflow.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as TestHost from "./TestHost.ts"

/** The service that the provider of the test publishes. */
class Probe extends Context.Service<Probe, { readonly name: string }>()(
	"@openbot-build/openbot/test/HostLifecycle.test/Probe",
) {}

const providerName = "@openbot-build/test-provider"
const consumerName = "@openbot-build/test-consumer"
const workflow = Engine.define("host-lifecycle-probe")
const open = Workflows.Policy.Public({ authorize: () => Effect.void })

/**
 * Two plugins of the test. The provider publishes `Probe`. The consumer needs
 * `Probe` and gives a workflow that waits until the test lets it end. Each
 * one notes when it closes, and the workflow notes each run.
 */
const probes = (
	note: (event: string) => Effect.Effect<void>,
	release: Deferred.Deferred<void>,
) => ({
	[providerName]: Feature.make(providerName)
		.stage({
			inject: [],
			services: Layer.effect(
				Probe,
				Effect.as(
					Effect.addFinalizer(() => note("provider closed")),
					Probe.of({ name: "probe" }),
				),
			),
			publishes: [Probe],
		})
		.done(),
	[consumerName]: Feature.make(consumerName).start({
		inject: [Probe, Workflows.Workflows],
		layer: Layer.effectDiscard(
			Effect.gen(function* () {
				// Added before the workflow, so it runs after the workflow is gone.
				yield* Effect.addFinalizer(() => note("consumer closed"))
				const probe = yield* Probe
				yield* (yield* Workflows.Workflows).contribute({
					workflow,
					plugin: "test",
					journal: 1,
					run: () =>
						note(`run with ${probe.name}`).pipe(
							Effect.andThen(Deferred.await(release)),
							Effect.andThen(note("run ended")),
						),
					policy: open,
				})
			}),
		),
	}),
})

/** The preset with the two plugins of the test at the end. */
const entries = [
	...PresetPlugins.entries,
	{ id: "test-provider", name: providerName },
	{ id: "test-consumer", name: consumerName },
]

/** Waits on the real clock until the check gives a value. */
const until = <A, E, R>(check: Effect.Effect<Option.Option<A>, E, R>) =>
	Effect.gen(function* () {
		while (true) {
			const found = yield* check
			if (Option.isSome(found)) return found.value
			yield* Effect.sleep("100 millis")
		}
	}).pipe(Effect.timeout("60 seconds"))

/** Waits until the list of events holds this event the given number of times. */
const reach = (
	events: Ref.Ref<ReadonlyArray<string>>,
	event: string,
	times = 1,
) =>
	until(
		Effect.map(Ref.get(events), (all) =>
			Option.liftPredicate(
				all,
				(all) => Arr.filter(all, (each) => each === event).length >= times,
			),
		),
	)

/** Waits until every fork of the host is active. */
const allActive = until(
	Effect.gen(function* () {
		const composition = yield* Composition.Composition
		const trees = yield* Stream.runHead(composition.forks)
		const forks = Composition.flatten(Option.getOrElse(trees, () => []))
		return Option.liftPredicate(
			forks,
			(forks) =>
				Arr.isReadonlyArrayNonEmpty(forks) &&
				Arr.every(forks, (fork) => fork.state._tag === "Active"),
		)
	}),
)

const actor = { kind: "member", organizationId: "org", userId: "user" } as const

// The database is a real server, so these tests use the real clock.
layer(BrowserHost.layerPlatform, {
	excludeTestServices: true,
	timeout: "240 seconds",
})((it) => {
	it.effect(
		"a restart of a provider stops its consumer first, and a running execution goes on in the next generation",
		() =>
			Effect.gen(function* () {
				const events = yield* Ref.make<ReadonlyArray<string>>([])
				const note = (event: string) => Ref.update(events, Arr.append(event))
				const release = yield* Deferred.make<void>()
				const options = yield* TestHost.makeSettings
				yield* TestHost.migrate(options)
				const context = yield* Layer.build(
					TestHost.layer({
						...options,
						entries,
						plugins: probes(note, release),
					}),
				)
				yield* Effect.gen(function* () {
					const composition = yield* Composition.Composition
					const store = yield* Store.Store
					yield* store.submit(
						"host-lifecycle",
						Execution.CommandKey.make("start"),
						{
							workflow: workflow._tag,
							resource: { kind: "Chat", id: "host-lifecycle" },
							identity: { owner: actor, actor },
							input: null,
						},
					)
					yield* reach(events, "run with probe")

					yield* composition.loader.update("test-provider", {
						disabled: true,
					})
					yield* reach(events, "provider closed")
					// graft stops the consumer before the provider that it uses.
					assert.deepStrictEqual(yield* Ref.get(events), [
						"run with probe",
						"consumer closed",
						"provider closed",
					])

					yield* composition.loader.update("test-provider", {
						disabled: false,
					})
					// The next generation hosts the workflow again and runs the execution again.
					yield* reach(events, "run with probe", 2)
					yield* Deferred.succeed(release, undefined)
					yield* reach(events, "run ended")
					yield* allActive
				}).pipe(Effect.provideContext(context))
			}).pipe(Effect.scoped),
	)

	it.effect("turning a plugin off and on again makes every fork active", () =>
		Effect.gen(function* () {
			const options = yield* TestHost.makeSettings
			yield* TestHost.migrate(options)
			const context = yield* Layer.build(TestHost.layer(options))
			yield* Effect.gen(function* () {
				const composition = yield* Composition.Composition
				const workflows = yield* Workflows.Workflows
				yield* composition.loader.update("bots", { disabled: true })
				yield* composition.loader.ready
				yield* composition.stable
				// Chats needs bots, so it waits, and its workflows are gone too.
				assert.isTrue(
					Option.isNone(yield* workflows.get(TurnWorkflow.workflow._tag)),
				)
				yield* composition.loader.update("bots", { disabled: false })
				yield* composition.loader.ready
				yield* allActive
			}).pipe(Effect.provideContext(context))
		}).pipe(Effect.scoped),
	)

	it.effect(
		"the routes of a plugin that is off answer 503, and the OpenAPI document stays the same",
		() =>
			Effect.gen(function* () {
				const options = yield* TestHost.makeSettings
				yield* TestHost.migrate(options)
				const context = yield* Layer.build(TestHost.layer(options))
				yield* Effect.gen(function* () {
					const composition = yield* Composition.Composition
					const address = HttpServer.formatAddress(
						(yield* HttpServer.HttpServer).address,
					)
					const get = (path: string) => HttpClient.get(address + path)
					/** The feature that the host names as off, if any. */
					const offFeature = Effect.map(
						get("/v1/triggers"),
						(answer) => answer.headers[FailureApi.featureHeader],
					)
					const document = Effect.flatMap(
						get("/openapi.json"),
						(answer) => answer.text,
					)
					const before = yield* document
					// The instance has no setup, so the plugin answers with a failure of its own.
					assert.isUndefined(yield* offFeature)

					yield* composition.loader.update("triggers", { disabled: true })
					yield* composition.loader.ready
					yield* composition.stable
					const off = yield* get("/v1/triggers")
					assert.strictEqual(off.status, 503)
					assert.strictEqual(off.headers[FailureApi.featureHeader], "triggers")
					assert.deepStrictEqual(yield* off.json, {
						_tag: "FeatureUnavailable",
						feature: "triggers",
					})
					// The contract does not change when a plugin is off.
					assert.strictEqual(yield* document, before)

					yield* composition.loader.update("triggers", { disabled: false })
					yield* composition.loader.ready
					yield* allActive
					assert.isUndefined(yield* offFeature)
				}).pipe(
					Effect.provideContext(context),
					Effect.provide(FetchHttpClient.layer),
				)
			}).pipe(Effect.scoped),
	)

	it.effect(
		"a restart of work closes the engine generation before the next one opens",
		() =>
			Effect.gen(function* () {
				// Sharding writes "Starting" from its read loop when it opens, and
				// "Shutdown complete" when it closes. A logger runs outside of
				// Effect, so it counts in plain variables.
				let open = 0
				let most = 0
				let opened = 0
				const counter = Logger.make((line) => {
					const notes = line.fiber.getRef(References.CurrentLogAnnotations)
					if (notes["module"] !== "effect/cluster/Sharding") return
					const message = Arr.isArray(line.message)
						? line.message[0]
						: line.message
					if (
						message === "Starting" &&
						notes["fiber"] === "Storage read loop"
					) {
						open += 1
						opened += 1
						most = Math.max(most, open)
					}
					if (message === "Shutdown complete") open -= 1
				})
				const options = yield* TestHost.makeSettings
				yield* TestHost.migrate(options)
				const context = yield* Layer.build(TestHost.layer(options)).pipe(
					Effect.provide(Logger.layer([counter])),
					Effect.provideService(References.MinimumLogLevel, "Debug"),
				)
				yield* Effect.gen(function* () {
					const composition = yield* Composition.Composition
					assert.strictEqual(open, 1)
					yield* composition.loader.update("work", { disabled: true })
					yield* composition.loader.ready
					yield* composition.stable
					yield* composition.loader.update("work", { disabled: false })
					yield* composition.loader.ready
					yield* allActive
					// The swap opens the next generation after the plugins settle.
					yield* until(
						Effect.sync(() =>
							Option.liftPredicate(opened, (opened) => opened >= 2),
						),
					)
					assert.strictEqual(open, 1)
					assert.strictEqual(most, 1)
				}).pipe(Effect.provideContext(context))
			}).pipe(Effect.scoped),
	)

	it.effect("the host does not start without a required plugin", () =>
		Effect.gen(function* () {
			const options = yield* TestHost.makeSettings
			yield* TestHost.migrate(options)
			const error = yield* Layer.build(
				TestHost.layer({
					...options,
					entries: Arr.map(PresetPlugins.entries, (entry) =>
						entry.id === "auth" ? { ...entry, disabled: true } : entry,
					),
				}),
			).pipe(Effect.flip)
			assert.deepStrictEqual(
				error,
				PresetPlugins.RequiredPluginMissing.make({ ids: ["auth"] }),
			)
		}).pipe(Effect.scoped),
	)

	it.effect(
		"the host does not start when a plugin fails, and it saves the failure",
		() =>
			Effect.gen(function* () {
				const options = yield* TestHost.makeSettings
				yield* TestHost.migrate(options)
				const missing = "@openbot-build/plugin-missing"
				const error = yield* Layer.build(
					TestHost.layer({
						...options,
						entries: [
							...PresetPlugins.entries,
							{ id: "missing", name: missing },
						],
					}),
				).pipe(Effect.scoped, Effect.flip)
				assert.strictEqual(error._tag, "PluginsInactive")
				const failed =
					error._tag === "PluginsInactive"
						? Arr.filter(error.forks, (fork) => fork.plugin === missing)
						: []
				assert.strictEqual(failed.length, 1)
				assert.strictEqual(failed[0]?.state, "Failed")
				const errorId = failed[0]?.errorId ?? ""
				// The full cause is in the error records of the same database, not in the error.
				const rows = yield* Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql<{
							readonly id: string
						}>`select id from openbot_execution_failures where id = ${errorId}`,
				).pipe(Effect.provide(TestHost.layerShared(options)))
				assert.strictEqual(rows.length, 1)
			}),
	)

	it.effect("a runtime edit cannot turn off a required plugin", () =>
		Effect.gen(function* () {
			const options = yield* TestHost.makeSettings
			yield* TestHost.migrate(options)
			const context = yield* Layer.build(TestHost.layer(options))
			const composition = Context.get(context, Composition.Composition)
			const error = yield* composition.loader
				.update("auth", { disabled: true })
				.pipe(Effect.flip)
			assert.strictEqual(error._tag, "StoreError")
			assert.deepStrictEqual(
				error._tag === "StoreError" ? error.cause : undefined,
				PresetPlugins.RequiredPluginMissing.make({ ids: ["auth"] }),
			)
		}).pipe(Effect.scoped),
	)
})
