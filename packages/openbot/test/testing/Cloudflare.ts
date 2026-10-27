import { assert } from "@effect/vitest"
import { PgClient } from "@effect/sql-pg"
import { SqlClient } from "effect/sql"
import { HostTools, OpenBot, Server } from "@openbot-build/openbot"
import {
	Array as Arr,
	Cause,
	Context,
	Deferred,
	Effect,
	FileSystem,
	Layer,
	Redacted,
	Ref,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { HttpServer } from "effect/http"
import { ChildProcess } from "effect/process"
import * as Secrets from "../../src/secrets/Secrets.ts"
import * as PostgresTest from "../PostgresTest.ts"
import { signIn } from "../DevelopmentLogin.ts"
import * as BuiltPrograms from "./BuiltPrograms.ts"

export const origin = "https://localhost:8443"
/** The built server did not start, or its migration failed. */
class EntryFailed extends Schema.TaggedError<
	EntryFailed,
	{ readonly brand: unique symbol }
>()("EntryFailed", { entry: Schema.String, reason: Schema.String }) {}

/** A request with a secret failed. Only scrubbed cause text can leave this test. */
class PrivateCallFailed extends Schema.TaggedError<
	PrivateCallFailed,
	{ readonly brand: unique symbol }
>()("PrivateCallFailed", { reason: Schema.String }) {}

const hide = (text: string, hidden: ReadonlyArray<string>) =>
	Arr.reduce(hidden, text, (value, secret) =>
		Str.replaceAll(secret, "<redacted>")(value),
	)

export const keepPrivate = <A, E, R>(
	self: Effect.Effect<A, E, R>,
	hidden: ReadonlyArray<string>,
) =>
	self.pipe(
		Effect.catchCause((cause) =>
			Effect.fail(
				PrivateCallFailed.make({
					reason: hide(Cause.pretty(cause), hidden),
				}),
			),
		),
	)

/** Starts a built server. Its process and output readers belong to the test scope. */
export const start = Effect.fn("CloudflareE2E.start")(function* (
	env: Readonly<Record<string, string>>,
) {
	const entry = yield* BuiltPrograms.path("server")
	const port = yield* PostgresTest.freePort
	const ready = yield* Deferred.make<string, EntryFailed>()
	const output = yield* Ref.make("")
	const child = yield* ChildProcess.make(process.execPath, [entry], {
		env: { ...env, OPENBOT_PORT: String(port) },
		extendEnv: true,
		stdin: "ignore",
		killSignal: "SIGINT",
	})
	yield* child.stdout.pipe(
		Stream.decodeText,
		Stream.runForEach((text) =>
			Effect.gen(function* () {
				const current = yield* Ref.updateAndGet(
					output,
					(before) => before + text,
				)
				const address = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(
					current,
				)?.[1]
				if (address !== undefined) yield* Deferred.succeed(ready, address)
			}),
		),
		Effect.forkScoped,
	)
	// Provider failures may hold the account address. Keep child logs out of test output.
	yield* child.stderr.pipe(Stream.runDrain, Effect.forkScoped)
	yield* child.exitCode.pipe(
		Effect.flatMap((code) =>
			Deferred.fail(
				ready,
				EntryFailed.make({
					entry,
					reason: `The process stopped with code ${code}`,
				}),
			),
		),
		Effect.forkScoped,
	)
	return yield* Deferred.await(ready).pipe(Effect.timeout("30 seconds"))
})

export const environment = (databaseUrl: string) => ({
	OPENBOT_DATABASE_URL: databaseUrl,
	OPENBOT_CLUSTER_SECRET: "test-cluster-secret-with-at-least-32-characters",
	OPENBOT_SECRET_KEYS:
		"test:1111111111111111111111111111111111111111111111111111111111111111",
	OPENBOT_HOST: "127.0.0.1",
})

/** Runs the built migration before the server starts. */
export const migrate = (env: ReturnType<typeof environment>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const entry = yield* BuiltPrograms.path("migrate")
			const migration = yield* ChildProcess.make(process.execPath, [entry], {
				env,
				extendEnv: true,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			})
			assert.strictEqual(yield* migration.exitCode, 0)
		}),
	)

/** Gives the production server a local session without development App work. */
export const seedSession = (env: ReturnType<typeof environment>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const options = {
				host: "127.0.0.1",
				port: 0,
				databaseUrl: Redacted.make(env.OPENBOT_DATABASE_URL),
				clusterSecret: Redacted.make(env.OPENBOT_CLUSTER_SECRET),
				secretKeys: Redacted.make(env.OPENBOT_SECRET_KEYS),
				auth: {
					mode: "development" as const,
					publicOrigin: origin,
					secret: Redacted.make("LiveTestSessionSecretMustRemainStable123456"),
				},
			}
			// DevelopmentMain starts App work in its own namespace. Main cannot run that work.
			const services = yield* Layer.build(
				Server.layerFixed(options).pipe(
					Layer.provide(Layer.merge(OpenBot.layerOutside, HostTools.none)),
					Layer.provideMerge(OpenBot.layerShared(options)),
				),
			)
			const address = HttpServer.formatAddress(
				Context.get(services, HttpServer.HttpServer).address,
			)
			return (yield* signIn(address, origin)).credential
		}),
	)

/** Writes saved failures after removing account and key values. */
export const writeFailureCauses = (
	databaseUrl: string,
	secretKeys: string,
	target: string,
	hidden: ReadonlyArray<string>,
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const sql = yield* SqlClient.SqlClient
		const secrets = yield* Secrets.Secrets
		const rows = yield* sql<{
			readonly id: string
			readonly cause: string
		}>`select id, cause from openbot_execution_failures`
		const causes = yield* Effect.forEach(rows, (row) =>
			secrets.open(row.cause, `failure:${row.id}`),
		)
		yield* fs.writeFileString(
			target,
			yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.Array(Schema.String)),
			)(Arr.map(causes, (cause) => hide(cause, hidden))),
		)
	}).pipe(
		Effect.provide(
			Layer.merge(
				PgClient.layer({ url: Redacted.make(databaseUrl) }),
				Secrets.layer(Redacted.make(secretKeys)),
			),
		),
	)
