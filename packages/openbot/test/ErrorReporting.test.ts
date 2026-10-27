import { assert, it } from "@effect/vitest"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import {
	Array as Arr,
	Cause,
	ConfigProvider,
	Effect,
	Exit,
	Layer,
	Logger,
	Redacted,
	References,
	Schema,
} from "effect"
import { HttpClient, HttpRouter, HttpServerResponse } from "effect/http"
import { Execution } from "@openbot-build/domain"
import { Records } from "../src/errors/Records.ts"
import * as ErrorReporting from "../src/errors/Reporting.ts"
import * as EnvironmentConfiguration from "../src/configuration/EnvironmentConfiguration.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"

const records = Layer.succeed(Records, {
	record: (_cause, category) =>
		Effect.logError("An operation failed.").pipe(
			Effect.as({ errorId: Execution.ErrorId.make("test-error-id"), category }),
		),
})

// The routes run on a real test server, so this test needs the real clock.
it.live(
	"HTTP failures are reported once with route templates, and rejections keep their status",
	() => {
		let logs: ReadonlyArray<Readonly<Record<string, unknown>>> = []
		const collector = Logger.layer([
			Logger.make((log) => {
				if (log.logLevel === "Error")
					logs = [...logs, log.fiber.getRef(References.CurrentLogAnnotations)]
			}),
		])
		const routes = Layer.mergeAll(
			HttpRouter.add(
				"GET",
				"/fault/:id",
				Effect.die(new Error("private-token")),
			),
			HttpRouter.add(
				"GET",
				"/unavailable",
				HttpServerResponse.empty({ status: 503 }),
			),
			HttpRouter.add(
				"GET",
				"/reject",
				HttpServerResponse.empty({ status: 400 }),
			),
			HttpRouter.add("GET", "/cancel", Effect.interrupt),
			ErrorReporting.layerHttp,
		)
		const server = HttpRouter.serve(routes, {
			disableLogger: true,
			disableListenLog: true,
		}).pipe(
			Layer.provide(collector),
			Layer.provide(records),
			Layer.provideMerge(NodeHttpServer.layerTest),
			// The error logs make their request ids with the Crypto service.
			Layer.provide(NodeServices.layer),
		)
		const status = (path: string) =>
			Effect.map(HttpClient.get(path), (response) => response.status)
		return Effect.gen(function* () {
			assert.strictEqual(
				yield* status("/fault/private-id?token=private-token"),
				500,
			)
			assert.strictEqual(yield* status("/unavailable"), 503)
			assert.strictEqual(yield* status("/reject"), 400)
			assert.strictEqual(yield* status("/missing"), 404)
			assert.strictEqual(yield* status("/cancel"), 503)
			assert.strictEqual(logs.length, 2)
			assert.deepStrictEqual(
				Arr.map(logs, (log) => log["route"]),
				["/fault/:id", "/unavailable"],
			)
			assert.match(String(logs[0]!["requestId"]), /^[0-9a-f-]{36}$/)
			assert.notMatch(
				yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(logs),
				/private-id|private-token/,
			)
		}).pipe(Effect.provide(server))
	},
)

// The route runs on a real test server, so this test needs the real clock.
it.live(
	"the logs of a failed request carry the request id of its error log",
	() => {
		let logs: ReadonlyArray<{
			readonly level: string
			readonly requestId: unknown
		}> = []
		const collector = Logger.layer([
			Logger.make((log) => {
				if (log.logLevel === "Warn" || log.logLevel === "Error")
					logs = [
						...logs,
						{
							level: log.logLevel,
							requestId: log.fiber.getRef(References.CurrentLogAnnotations)[
								"requestId"
							],
						},
					]
			}),
		])
		const routes = Layer.mergeAll(
			HttpRouter.add(
				"GET",
				"/unavailable",
				Effect.logWarning("The store failed.").pipe(
					Effect.as(HttpServerResponse.empty({ status: 503 })),
				),
			),
			ErrorReporting.layerHttp,
		)
		const server = HttpRouter.serve(routes, {
			disableLogger: true,
			disableListenLog: true,
		}).pipe(
			Layer.provide(collector),
			Layer.provide(records),
			Layer.provideMerge(NodeHttpServer.layerTest),
			// The error logs make their request ids with the Crypto service.
			Layer.provide(NodeServices.layer),
		)
		return Effect.gen(function* () {
			assert.strictEqual((yield* HttpClient.get("/unavailable")).status, 503)
			assert.deepStrictEqual(
				Arr.map(logs, (log) => log.level),
				["Warn", "Error"],
			)
			assert.match(String(logs[0]!.requestId), /^[0-9a-f-]{36}$/)
			assert.strictEqual(logs[0]!.requestId, logs[1]!.requestId)
		}).pipe(Effect.provide(server))
	},
)

it.effect(
	"startup reports configuration failure before a database is available and keeps its failure",
	() =>
		Effect.gen(function* () {
			let sent = 0
			const exit = yield* ErrorReporting.withStartup(
				EnvironmentConfiguration.load,
			).pipe(
				Effect.provideService(
					ConfigProvider.ConfigProvider,
					ConfigProvider.fromUnknown({
						OPENBOT_CLUSTER_SECRET:
							"test-cluster-secret-with-at-least-32-characters",
					}),
				),
				Effect.provide(
					Logger.layer([
						Logger.make((log) => {
							if (log.logLevel === "Error") sent++
						}),
					]),
				),
				Effect.exit,
			)
			assert.ok(Exit.isFailure(exit))
			assert.strictEqual(sent, 1)
			if (Exit.isFailure(exit))
				assert.match(Cause.pretty(exit.cause), /OPENBOT_DATABASE_URL/)
			const cancelled = yield* ErrorReporting.withStartup(
				Effect.interrupt,
			).pipe(
				Effect.provide(
					Logger.layer([
						Logger.make(() => {
							sent++
						}),
					]),
				),
				Effect.exit,
			)
			assert.ok(Exit.isFailure(cancelled))
			assert.strictEqual(sent, 1)
		}),
)

// The database client tries a real network connection, so this test needs the real clock.
it.live("database startup failure is reported without a working database", () =>
	Effect.gen(function* () {
		let sent = 0
		const program = DatabasePostgres.check.pipe(
			Effect.provide(
				DatabasePostgres.layer({
					databaseUrl: Redacted.make("postgres://127.0.0.1:1/unavailable"),
				}).pipe(Layer.provide(NodeServices.layer)),
			),
		)
		const exit = yield* ErrorReporting.withStartup(program).pipe(
			Effect.provide(
				Logger.layer([
					Logger.make((log) => {
						if (log.logLevel === "Error") sent++
					}),
				]),
			),
			Effect.exit,
		)
		assert.ok(Exit.isFailure(exit))
		assert.strictEqual(sent, 1)
	}),
)
