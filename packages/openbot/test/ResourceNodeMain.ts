// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer needs the native server factory.
import { createServer } from "node:http"
import {
	NodeHttpClient,
	NodeHttpServer,
	NodeRuntime,
	NodeServices,
	NodeSocket,
} from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import {
	Config,
	Deferred,
	Effect,
	Layer,
	Option,
	Redacted,
	Schedule,
	Stream,
	String as Str,
} from "effect"
import {
	Runner,
	RunnerAddress,
	RunnerStorage,
	ShardingConfig,
	SqlRunnerStorage,
} from "effect/cluster"
import { HttpRouter, HttpServerResponse } from "effect/http"
import * as Directory from "../src/resources/Directory.ts"
import * as Transport from "../src/resources/Transport.ts"
import * as Records from "../src/errors/Records.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as PrivateRpc from "../src/transport/PrivateRpc.ts"

const ref = { namespace: "process-test", kind: "socket", id: "one" }
const app = Layer.unwrap(
	Effect.gen(function* () {
		const runner = yield* Config.Int("TEST_RUNNER_ID")
		const port = yield* Config.Int("TEST_SERVER_PORT")
		const advertised = yield* Config.Int("TEST_ADVERTISE_PORT")
		const physicalPort = yield* Config.Int("TEST_PHYSICAL_PORT")
		const url = yield* Config.Redacted("TEST_DATABASE_URL")
		const address = RunnerAddress.make("127.0.0.1", advertised)
		const register = Layer.effectDiscard(
			Effect.gen(function* () {
				const runners = yield* RunnerStorage.RunnerStorage
				yield* runners.register(
					Runner.Runner.make({ address, groups: ["default"], weight: 1 }),
					true,
				)
				const sql = yield* PgClient.PgClient
				yield* sql`insert into resource_test_nodes (runner, port) values (${runner}, ${port})`
			}),
		)
		const hold = (ready: Deferred.Deferred<void>, replace = false) =>
			Effect.gen(function* () {
				const transport = yield* Transport.Transport
				const sql = yield* PgClient.PgClient
				return yield* transport.own(
					ref,
					() => Stream.succeed(runner),
					{ admit: Effect.void, replace },
					() =>
						Effect.gen(function* () {
							const socket = yield* NodeSocket.makeNet({
								host: "127.0.0.1",
								port: physicalPort,
							})
							yield* socket.reader
							if (runner === 1)
								yield* Effect.addFinalizer(() =>
									sql<{
										readonly hold: boolean
									}>`select hold from resource_test_close`.pipe(
										Effect.repeat({
											schedule: Schedule.spaced("50 millis"),
											until: (rows) => rows[0]?.hold !== true,
										}),
										// The socket must close even when the test has cut all database traffic.
										Effect.catchCause((cause) =>
											Effect.logDebug(
												"The test close gate lost database access.",
												cause,
											),
										),
									),
								)
							yield* Deferred.succeed(ready, undefined)
							return yield* Effect.never
						}),
				)
			})
		const owner = Layer.effectDiscard(
			Effect.gen(function* () {
				if (runner !== 1) return
				const ready = yield* Deferred.make<void>()
				yield* hold(ready).pipe(Effect.exit, Effect.forkScoped)
			}),
		)
		const controls = Layer.effectDiscard(
			Effect.gen(function* () {
				const router = yield* HttpRouter.HttpRouter
				const gate = yield* PrivateRpc.make
				const transport = yield* Transport.Transport
				const scope = yield* Effect.scope
				const context = yield* Effect.context<
					Transport.Transport | PgClient.PgClient
				>()
				yield* router.add(
					"POST",
					"/replace",
					gate.protect(
						Effect.gen(function* () {
							const ready = yield* Deferred.make<void>()
							yield* hold(ready, true).pipe(
								Effect.provideContext(context),
								Effect.exit,
								Effect.forkIn(scope),
							)
							yield* Deferred.await(ready)
							return HttpServerResponse.empty()
						}),
					),
				)
				yield* router.add(
					"POST",
					"/release",
					gate.protect(
						transport.release(ref).pipe(
							Effect.match({
								onFailure: (error) => HttpServerResponse.jsonUnsafe(error),
								onSuccess: () =>
									HttpServerResponse.jsonUnsafe({ _tag: "Closed" }),
							}),
						),
					),
				)
			}),
		)
		const database = PgClient.layer({ url, connectTimeout: "1 second" })
		const runners = SqlRunnerStorage.layerStorage({ prefix: "openbot_cluster" })
		const services = Transport.layer.pipe(
			Layer.provideMerge(Directory.layer),
			Layer.provide(
				Records.layer.pipe(
					Layer.provide(
						Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
					),
				),
			),
			Layer.provideMerge(register.pipe(Layer.provideMerge(runners))),
			Layer.provideMerge(database),
			Layer.provide(
				ShardingConfig.layer({ runnerAddress: Option.some(address) }),
			),
			Layer.provide(NodeHttpClient.layerUndici),
		)
		return HttpRouter.serve(
			Layer.mergeAll(Transport.layerRoutes, controls, owner).pipe(
				Layer.provide(services),
			),
			{
				disableLogger: true,
				disableListenLog: true,
			},
		).pipe(
			Layer.provide(
				NodeHttpServer.layer(createServer, { host: "127.0.0.1", port }),
			),
			Layer.provide(
				Layer.succeed(PrivateRpc.Secret, Redacted.make("resource-test")),
			),
		)
	}),
)
Layer.launch(app.pipe(Layer.provide(NodeServices.layer))).pipe(
	NodeRuntime.runMain,
)
