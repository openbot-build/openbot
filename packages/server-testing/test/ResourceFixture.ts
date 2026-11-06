import * as TestDatabase from "@openbot-build/server-database/Testing"
import * as Migrations from "@openbot-build/server-database/Migrations"
import { PgClient } from "@effect/sql-pg"
import {
	NodeCrypto,
	NodeHttpClient,
	NodeHttpServer,
	NodeServices,
} from "@effect/platform-node"
import {
	Context,
	Effect,
	Exit,
	Layer,
	Option,
	Redacted,
	Scope,
	String as Str,
} from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import {
	Runner,
	RunnerAddress,
	RunnerStorage,
	ShardingConfig,
} from "effect/cluster"
import { HttpClient, HttpRouter, HttpServer } from "effect/http"
import { SqlClient } from "effect/sql"
import * as Records from "@openbot-build/server-kernel/Records"
import * as Secrets from "@openbot-build/server-kernel/Secrets"
import * as Directory from "@openbot-build/server-execution/Directory"
import * as Transport from "@openbot-build/server-execution/Transport"
import * as PrivateRpc from "@openbot-build/server-execution/PrivateRpc"

const database = Layer.effectDiscard(Migrations.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(TestDatabase.start, (db) =>
				PgClient.layer({ url: Redacted.make(db.url) }),
			),
		),
	),
)
export const services = Records.layer.pipe(
	Layer.provide(Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11")))),
	Layer.provideMerge(database),
	Layer.provideMerge(RunnerStorage.layerMemory),
	Layer.provideMerge(NodeHttpClient.layerUndici),
	Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
)
const secret = Layer.succeed(PrivateRpc.Secret, Redacted.make("private-test"))
export const start = (options?: {
	readonly transactions?: Layer.Layer<SqlClient.SqlClient>
	readonly errors?: Records.Records["Service"]
	readonly http?: HttpClient.HttpClient
	readonly directory?: (
		service: Directory.Directory["Service"],
	) => Directory.Directory["Service"]
}) =>
	Effect.gen(function* () {
		const shared = yield* Effect.context<
			| Records.Records
			| PgClient.PgClient
			| SecureRandom.SecureRandom
			| Digest.Digest
			| RunnerStorage.RunnerStorage
			| HttpClient.HttpClient
			| SqlClient.SqlClient
		>()
		const scope = yield* Scope.fork(yield* Scope.Scope)
		const config = Layer.unwrap(
			Effect.gen(function* () {
				const server = yield* HttpServer.HttpServer
				if (server.address._tag === "UnixPathAddress")
					return yield* Effect.die("The test needs TCP.")
				const address = RunnerAddress.make("127.0.0.1", server.address.port)
				const runners = yield* RunnerStorage.RunnerStorage
				yield* Effect.acquireRelease(
					runners.register(
						Runner.Runner.make({ address, groups: ["default"], weight: 1 }),
						true,
					),
					() => runners.unregister(address).pipe(Effect.orDie),
				)
				return ShardingConfig.layer({ runnerAddress: Option.some(address) })
			}),
		)
		const directory = Directory.layer.pipe(
			Layer.provide(
				options?.transactions ??
					Layer.succeed(
						SqlClient.SqlClient,
						Context.get(shared, SqlClient.SqlClient),
					),
			),
		)
		const directoryLayer =
			options?.directory === undefined
				? directory
				: Layer.effect(
						Directory.Directory,
						Effect.map(Directory.Directory, options.directory),
					).pipe(Layer.provide(directory))
		const node = HttpRouter.serve(Transport.layerRoutes, {
			disableLogger: true,
			disableListenLog: true,
		}).pipe(
			Layer.provideMerge(
				Transport.layer.pipe(
					Layer.provideMerge(directoryLayer),
					Layer.provide(
						options?.http === undefined
							? NodeHttpClient.layerUndici
							: Layer.succeed(HttpClient.HttpClient, options.http),
					),
				),
			),
			Layer.provide(config),
			Layer.provide(secret),
			Layer.provideMerge(NodeHttpServer.layerTest),
			Layer.provide(
				Layer.succeedContext(
					shared.pipe(
						Context.add(
							Records.Records,
							options?.errors ?? Context.get(shared, Records.Records),
						),
					),
				),
			),
		)
		const context = yield* Layer.build(node).pipe(Scope.provide(scope))
		const server = Context.get(context, HttpServer.HttpServer)
		if (server.address._tag === "UnixPathAddress")
			return yield* Effect.die("The test needs TCP.")
		return {
			transport: Context.get(context, Transport.Transport),
			directory: Context.get(context, Directory.Directory),
			url: `http://127.0.0.1:${server.address.port}`,
			close: Scope.close(scope, Exit.void),
		}
	})
