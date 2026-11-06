/**
 * One server process of LimitProcessRestart.test.ts. It is the full server
 * with the plugins file of the test, the wait-feature plugin of the test,
 * and a model that asks for a host tool twice and answers in its third step.
 * The model writes each request to `limit_restart_calls`. When
 * `LIMIT_RESTART_HOLD` names the number of tool results of a request, or is
 * `always`, the request writes `held` and never ends. The process writes its
 * address to `limit_restart_nodes` when it is ready.
 */
import { NodeCrypto, NodeRuntime, NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Host, Preset } from "@openbot-build/openbot"
import { Config as Core, Model, Provider } from "@openbot-build/core"
import { BuiltinModels } from "@openbot-build/models-contract/BuiltinModels"
import { Settings } from "@openbot-build/server-kernel/Settings"
import * as HostTools from "@openbot-build/tools-contract/HostTools"
import {
	Config,
	Context,
	Effect,
	Layer,
	Option,
	Redacted,
	Schema,
	String as Str,
} from "effect"
import { Tool, Toolkit } from "effect/ai"
import { FetchHttpClient, HttpServer } from "effect/http"
import { toolsThenAnswer, waitPlugin } from "./LimitFixture.ts"

const getValue = Tool.make("GetValue", {
	description: "Read a named value",
	parameters: Schema.Struct({ key: Schema.String }),
	success: Schema.Struct({ value: Schema.NullOr(Schema.String) }),
})
const toolkit = Toolkit.make(getValue)

const main = Effect.gen(function* () {
	const databaseUrl = yield* Config.Redacted("LIMIT_RESTART_DATABASE_URL")
	const node = yield* Config.Int("LIMIT_RESTART_NODE")
	const pluginsFile = yield* Config.String("LIMIT_RESTART_PLUGINS_FILE")
	const hold = yield* Config.String("LIMIT_RESTART_HOLD")
	// The node writes what it sees into the test tables with its own pool.
	const testTables = yield* Layer.build(PgClient.layer({ url: databaseUrl }))
	const sql = Context.get(testTables, PgClient.PgClient)
	const model = yield* toolsThenAnswer(2, (results) =>
		Effect.gen(function* () {
			const held = hold === "always" || hold === String(results)
			yield* sql`insert into limit_restart_calls (node, results, held)
				values (${node}, ${results}, ${held})`.pipe(Effect.orDie)
			return !held
		}),
	)
	const provider = Provider.Id.make("fixture")
	const modelId = Model.Id.make("fixture-model")
	const server = Host.layer({
		databaseUrl,
		host: "127.0.0.1",
		port: 0,
		pluginsFile,
		clusterSecret: Redacted.make(
			"test-cluster-secret-with-at-least-32-characters",
		),
		secretKeys: Redacted.make("test:" + Str.repeat(32)("11")),
		auth: {
			mode: "development" as const,
			publicOrigin: "https://localhost:8443",
			secret: Redacted.make("LimitRestartSecretMustRemainStable123456"),
		},
		plugins: waitPlugin.plugins,
		entries: [...Preset.entries, waitPlugin.entry],
		outside: Layer.succeed(BuiltinModels, {
			providers: [{ id: provider, name: "Test provider" }],
			models: [
				Core.Model.make({
					provider,
					id: modelId,
					name: "Fixture model",
					description: "A model with fixed answers for limit tests",
					reasoningEfforts: ["low", "high"],
					serviceTiers: ["default", "priority"],
					contextWindow: 32000,
					maxOutputTokens: 4000,
				}),
			],
			resolve: () => Effect.succeed(model),
			defaultModel: Core.Selection.make({ provider, model: modelId }),
		}),
		hostTools: HostTools.layer({
			toolkit,
			handlers: () =>
				toolkit.toLayer({ GetValue: () => Effect.succeed({ value: null }) }),
		}),
	})
	const app = Layer.effectDiscard(
		Effect.gen(function* () {
			const settings = yield* Settings
			const platform = Option.getOrThrow(yield* settings.platform)
			yield* settings.updatePlatform(platform.version, (p) =>
				Effect.succeed({ ...p, organizationCreation: "anyone" }),
			)
			const http = yield* HttpServer.HttpServer
			const address = HttpServer.formatAddress(http.address)
			yield* sql`insert into limit_restart_nodes (node, address) values (${node}, ${address})`
		}),
	).pipe(Layer.provideMerge(server))
	return yield* Layer.launch(app)
}).pipe(
	Effect.scoped,
	Effect.provide(
		Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer),
	),
)

NodeRuntime.runMain(main)
