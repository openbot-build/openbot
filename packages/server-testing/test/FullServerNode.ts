import { Settings } from "@openbot-build/server-kernel/Settings"
import { Option } from "effect"
import { NodeCrypto, NodeRuntime, NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import {
	Config,
	Context,
	Effect,
	Layer,
	Redacted,
	Stream,
	String as Str,
} from "effect"
import { FetchHttpClient, HttpServer } from "effect/http"
import * as DevelopmentModel from "@openbot-build/server-development/DevelopmentModel"
import { Host } from "@openbot-build/openbot"
import { BuiltinModels } from "@openbot-build/models-contract/BuiltinModels"
import * as HostTools from "@openbot-build/tools-contract/HostTools"
import { CurrentCallIdentity } from "@openbot-build/server-billing/MeteredModel"
import {
	methodsOf,
	withMethods,
} from "@openbot-build/server-billing/ModelMethods"

/** This is the full server assembly. Only model and host tool results are fixed. */
const main = Effect.gen(function* () {
	const databaseUrl = yield* Config.Redacted("FULL_SERVER_DATABASE_URL")
	const node = yield* Config.Int("FULL_SERVER_NODE")
	const options = {
		databaseUrl,
		host: "127.0.0.1",
		port: 0,
		clusterSecret: Redacted.make(
			"test-cluster-secret-with-at-least-32-characters",
		),
		secretKeys: Redacted.make("test:" + Str.repeat(32)("11")),
		auth: {
			mode: "development" as const,
			publicOrigin: "https://localhost:8443",
			secret: Redacted.make("FullServerSecretMustRemainStable123456789"),
		},
	}
	// The node writes what it sees into the test tables with its own pool.
	const testTables = yield* Layer.build(PgClient.layer({ url: databaseUrl }))
	const sql = Context.get(testTables, PgClient.PgClient)
	const { builtinModels } = yield* DevelopmentModel.make
	const server = Host.layer({
		...options,
		outside: Layer.succeed(BuiltinModels, {
			...builtinModels,
			resolve: (selection) =>
				builtinModels.resolve(selection).pipe(
					Effect.map((model) => {
						const methods = methodsOf(model)
						return withMethods(model, {
							...methods,
							streamText: (input) =>
								Stream.unwrap(
									Effect.gen(function* () {
										const call = yield* CurrentCallIdentity
										if (call === undefined)
											return yield* Effect.die(
												"The model call has no execution.",
											)
										yield* sql`insert into full_server_calls (call_id, execution_id, node, sends)
													values (${call.id}, ${call.executionId}, ${node}, 1)
													on conflict (call_id) do update set sends = full_server_calls.sends + 1`.pipe(
											Effect.orDie,
										)
										return methods.streamText(input)
									}),
								),
						})
					}),
				),
		}),
		hostTools: HostTools.layer({
			toolkit: DevelopmentModel.toolkit,
			handlers: (chat) =>
				DevelopmentModel.toolkit.toLayer({
					DevelopmentConfirmation: ({ description }) =>
						sql`insert into full_server_tools (chat, node, description)
										values (${chat}, ${node}, ${description})`.pipe(
							Effect.orDie,
							Effect.as({ confirmed: description }),
						),
				}),
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
			yield* sql`insert into full_server_nodes (node, address) values (${node}, ${address})`
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
