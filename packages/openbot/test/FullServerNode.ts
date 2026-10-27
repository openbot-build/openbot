import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Config, Effect, Layer, Redacted, Stream, String as Str } from "effect"
import { FetchHttpClient, HttpServer } from "effect/http"
import * as DevelopmentModel from "../src/app/DevelopmentModel.ts"
import * as OpenBot from "../src/app/OpenBot.ts"
import * as Server from "../src/app/Server.ts"
import * as HostTools from "../src/chats/HostTools.ts"
import { CurrentCallIdentity } from "../src/billing/MeteredModel.ts"
import { methodsOf, withMethods } from "../src/models/ModelMethods.ts"

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
	const app = Layer.unwrap(
		Effect.gen(function* () {
			const sql = yield* PgClient.PgClient
			const { builtinModels } = yield* DevelopmentModel.make
			const server = Server.layerFixed({
				...options,
				builtinModels: {
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
				},
			}).pipe(
				Layer.provide(OpenBot.layerOutside),
				Layer.provide(
					HostTools.layer({
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
				),
			)
			return Layer.effectDiscard(
				Effect.gen(function* () {
					const http = yield* HttpServer.HttpServer
					const address = HttpServer.formatAddress(http.address)
					yield* sql`insert into full_server_nodes (node, address) values (${node}, ${address})`
				}),
			).pipe(Layer.provideMerge(server))
		}),
	).pipe(Layer.provideMerge(OpenBot.layerShared(options)))
	return yield* Layer.launch(app)
}).pipe(Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)))

NodeRuntime.runMain(main)
