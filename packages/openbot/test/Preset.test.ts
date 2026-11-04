import { assert, layer } from "@effect/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	HashMap,
	HashSet,
	Layer,
	Order,
	Stream,
	String as Str,
} from "effect"
import { HttpRouter } from "effect/http"
import type { Fork } from "@graftland/graft"
import * as BillingHost from "../src/app/BillingHost.ts"
import * as Composition from "../src/app/Composition.ts"
import * as ExecutionLayers from "../src/app/ExecutionLayers.ts"
import * as ComputerWorker from "../src/plugin-computers/Worker.ts"
import * as EngineHost from "../src/server-execution/execution/EngineHost.ts"
import * as ResourceTransport from "../src/server-execution/resources/Transport.ts"
import * as Host from "../src/app/Host.ts"
import * as OpenBot from "../src/app/OpenBot.ts"
import * as Preset from "../src/app/Preset.ts"
import * as Server from "../src/app/Server.ts"
import { BotFeatures } from "../src/conversation-contract/chats/BotFeatures.ts"
import { Workflows } from "../src/server-execution/execution/Workflows.ts"
import { HttpHost } from "../src/server-kernel/errors/HttpHost.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as HostFixture from "./HostFixture.ts"

/** What one assembly gives: its workflows, its bot features and its groups. */
interface Parts {
	readonly workflows: ReadonlyArray<string>
	readonly features: ReadonlyArray<string>
	readonly groups: ReadonlyArray<string>
}

/** Reads the parts of an assembly that the test compares. */
const partsOf = Effect.gen(function* () {
	const workflows = yield* Workflows
	const features = yield* BotFeatures
	const host = yield* HttpHost
	return {
		workflows: Arr.sort(yield* workflows.names, Order.String),
		features: Arr.map(yield* features.snapshot, (pin) => pin.id),
		groups: Arr.sort(Arr.fromIterable(yield* host.mounted), Order.String),
	} satisfies Parts
})

/** Builds a layer in its own scope, reads the parts, and closes the scope. */
const inScope = <A, E, R, B, E2, R2>(
	app: Layer.Layer<A, E, R>,
	read: Effect.Effect<B, E2, R2 | A>,
) =>
	Effect.scoped(
		Effect.flatMap(Layer.build(app), (context) =>
			Effect.provideContext(read, context),
		),
	)

/**
 * The static assembly, as `Server.layerApp` built it before the plugin host:
 * `OpenBot.layer`, `ExecutionLayers` and `Http`. Stage 7b removes it.
 */
const staticApp = (options: HostFixture.Settings) =>
	Layer.mergeAll(
		ComputerWorker.layer,
		Layer.effectDiscard(
			Effect.gen(function* () {
				const host = yield* HttpHost
				yield* host.mountRoutes("execution-rpc", EngineHost.layerRoutes)
				yield* host.mountRoutes("resource-rpc", ResourceTransport.layerRoutes)
			}).pipe(Effect.catchTag("MountConflict", Effect.die)),
		),
	).pipe(
		Layer.provideMerge(Server.layerApi),
		Layer.provideMerge(ExecutionLayers.layer),
		Layer.provideMerge(BillingHost.layer),
		Layer.provideMerge(OpenBot.layer(options)),
		Layer.provideMerge(Host.executionServices(options)),
	)

/** The static assembly on its own database and its own HTTP server. */
const staticParts = Effect.gen(function* () {
	const options = yield* HostFixture.configure
	yield* HostFixture.migrate(options)
	const app = HostFixture.outside(options)(
		HttpRouter.serve(staticApp(options), { disableLogger: true }),
	).pipe(Layer.provideMerge(HostFixture.serverOf(options)))
	return yield* inScope(app, partsOf)
})

/**
 * Every fork, parents first, with its state. Its name has two spaces for each
 * level of the tree. Children with the same parent are in the order of their
 * names, so the list does not change with the order of a parallel start.
 */
const outline = (
	trees: ReadonlyArray<Fork.ForkTree>,
	depth: number,
): ReadonlyArray<{
	readonly id: number
	readonly name: string
	readonly state: string
}> =>
	Arr.flatMap(
		Arr.sortWith(trees, (tree) => tree.name, Order.String),
		(tree: Fork.ForkTree) => [
			{
				id: tree.id,
				name: Str.repeat(depth)("  ") + tree.name,
				state: tree.state._tag,
			},
			...outline(tree.children, depth + 1),
		],
	)

const forkStates = Effect.gen(function* () {
	const composition = yield* Composition.Composition
	const trees = yield* Stream.runHead(composition.forks)
	return outline(trees._tag === "Some" ? trees.value : [], 0)
})

/** The host with the preset, on its own database and its own HTTP server. */
const hostParts = Effect.gen(function* () {
	const options = yield* HostFixture.configure
	yield* HostFixture.migrate(options)
	return yield* inScope(
		HostFixture.host(options),
		Effect.gen(function* () {
			const before = yield* forkStates
			const parts = yield* partsOf
			// The tree must stay as it is: no fork restarts or goes away.
			yield* Effect.sleep(Duration.seconds(2))
			const after = yield* forkStates
			const context = yield* Effect.context<never>()
			const current = yield* Effect.flatMap(Workflows, (w) => w.current)
			return {
				before,
				after,
				parts,
				workflowPlugins: HashSet.fromIterable(
					Arr.map(
						Arr.fromIterable(HashMap.values(current)),
						(contribution) => contribution.plugin,
					),
				),
				kernelKeys: HashSet.fromIterable(context.mapUnsafe.keys()),
			}
		}),
	)
})

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"the preset starts every plugin and gives the same parts as the static assembly",
		() =>
			Effect.gen(function* () {
				const host = yield* hostParts
				const expected = yield* staticParts

				assert.deepStrictEqual(
					Arr.filter(host.before, (fork) => fork.state !== "Active"),
					[],
				)
				assert.deepStrictEqual(host.after, host.before)
				assert.deepStrictEqual(
					Arr.map(host.before, (fork) => fork.name),
					forkNames,
				)
				assert.deepStrictEqual(host.parts, expected)
				assert.strictEqual(expected.features.length, 5)
				assert.strictEqual(expected.groups.length, 45)
				assert.isAbove(expected.workflows.length, 30)

				// A plugin that gives a bot feature gives a workflow too. Its
				// workflows close before the feature, so a Turn never outlives it.
				assert.deepStrictEqual(
					Arr.filter(
						host.parts.features,
						(feature) =>
							!HashSet.has(
								host.workflowPlugins,
								Str.replace("@openbot-build/plugin-", "")(feature),
							),
					),
					[],
				)

				// No plugin publishes a key of the kernel.
				const published = Arr.map(Preset.published, (key) => key.key)
				assert.deepStrictEqual(
					Arr.filter(published, (key) => HashSet.has(host.kernelKeys, key)),
					[],
				)
			}),
		{ timeout: 240_000 },
	)
})

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect("the preset has one entry for each id, in the same order", () =>
		Effect.sync(() => {
			assert.deepStrictEqual(
				Arr.map(Preset.modules, (module) => module.id),
				[...Preset.ids],
			)
			assert.deepStrictEqual(
				Arr.map(Preset.entries, (entry) => entry.id),
				[...Preset.ids],
			)
			assert.deepStrictEqual(
				Arr.map(Preset.entries, (entry) => entry.name),
				Arr.map(Preset.ids, Preset.nameOf),
			)
		}),
	)
})

/**
 * The fork tree of the preset. A change here is a change in how the plugins
 * start, so check it with care.
 */
const forkNames: ReadonlyArray<string> = [
	"openbot/executions",
	"openbot/loader",
	"  group",
	"    @openbot-build/plugin-access",
	"      @openbot-build/plugin-access",
	"        @openbot-build/plugin-access#start",
	"    @openbot-build/plugin-apps",
	"      @openbot-build/plugin-apps",
	"        @openbot-build/plugin-apps#session",
	"          @openbot-build/plugin-apps#start",
	"    @openbot-build/plugin-audit",
	"      @openbot-build/plugin-audit",
	"    @openbot-build/plugin-auth",
	"      @openbot-build/plugin-auth",
	"        @openbot-build/plugin-auth#start",
	"    @openbot-build/plugin-authorization",
	"      @openbot-build/plugin-authorization",
	"    @openbot-build/plugin-billing",
	"      @openbot-build/plugin-billing",
	"        @openbot-build/plugin-billing#start",
	"    @openbot-build/plugin-bots",
	"      @openbot-build/plugin-bots",
	"        @openbot-build/plugin-bots#bots",
	"          @openbot-build/plugin-bots#delegations",
	"            @openbot-build/plugin-bots#start",
	"    @openbot-build/plugin-capabilities",
	"      @openbot-build/plugin-capabilities",
	"        @openbot-build/plugin-capabilities#requests",
	"          @openbot-build/plugin-capabilities#start",
	"    @openbot-build/plugin-channels",
	"      @openbot-build/plugin-channels",
	"        @openbot-build/plugin-channels#start",
	"    @openbot-build/plugin-chats",
	"      @openbot-build/plugin-chats",
	"        @openbot-build/plugin-chats#turns",
	"          @openbot-build/plugin-chats#start",
	"    @openbot-build/plugin-code",
	"      @openbot-build/plugin-code",
	"        @openbot-build/plugin-code#start",
	"    @openbot-build/plugin-computers",
	"      @openbot-build/plugin-computers",
	"        @openbot-build/plugin-computers#start",
	"    @openbot-build/plugin-files",
	"      @openbot-build/plugin-files",
	"        @openbot-build/plugin-files#start",
	"    @openbot-build/plugin-imported",
	"      @openbot-build/plugin-imported",
	"        @openbot-build/plugin-imported#start",
	"    @openbot-build/plugin-mail",
	"      @openbot-build/plugin-mail",
	"    @openbot-build/plugin-models",
	"      @openbot-build/plugin-models",
	"        @openbot-build/plugin-models#start",
	"    @openbot-build/plugin-organization",
	"      @openbot-build/plugin-organization",
	"        @openbot-build/plugin-organization#start",
	"    @openbot-build/plugin-platform",
	"      @openbot-build/plugin-platform",
	"        @openbot-build/plugin-platform#start",
	"    @openbot-build/plugin-settings",
	"      @openbot-build/plugin-settings",
	"    @openbot-build/plugin-sso",
	"      @openbot-build/plugin-sso",
	"        @openbot-build/plugin-sso#start",
	"    @openbot-build/plugin-triggers",
	"      @openbot-build/plugin-triggers",
	"        @openbot-build/plugin-triggers#start",
	"    @openbot-build/plugin-vaults",
	"      @openbot-build/plugin-vaults",
	"        @openbot-build/plugin-vaults#start",
	"    @openbot-build/plugin-work",
	"      @openbot-build/plugin-work",
	"        @openbot-build/plugin-work#commands",
	"          @openbot-build/plugin-work#start",
	"openbot/loader-capture",
]
