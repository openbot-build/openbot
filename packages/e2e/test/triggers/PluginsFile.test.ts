import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { FailureApi, OpenBotApi } from "@openbot-build/api"
import { BuiltPrograms, PostgresTest } from "@openbot-build/openbot/testing"
import {
	Array as Arr,
	Deferred,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Option,
	Path,
	Redacted,
	Ref,
	Schedule,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { OpenApi } from "effect/http-api"
import { ChildProcess } from "effect/process"

/** A built program ended, or did not get ready in time. */
class ProgramFailed extends Schema.TaggedError<
	ProgramFailed,
	{ readonly brand: unique symbol }
>()("ProgramFailed", {
	reason: Schema.String,
	output: Schema.String,
}) {
	override get message() {
		return `${this.reason}: ${this.output}`
	}
}

/** What `openbot-inspect plugins` prints. */
const Report = Schema.Struct({
	file: Schema.NullOr(Schema.String),
	manifestHash: Schema.String,
	entries: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			disabled: Schema.Boolean,
			changed: Schema.Array(Schema.String),
		}),
	),
})
const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(Report))
const toJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const Unavailable = Schema.Struct({
	_tag: Schema.String,
	feature: Schema.String,
})

const settings = {
	publicOrigin: "https://openbot.example.com",
	identityProvider: { issuer: "https://id.example.com", clientId: "check" },
	adminEmails: ["admin@example.com"],
}

// The programs are real servers, so the test needs the real clock.
layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer), {
	excludeTestServices: true,
	timeout: "120 seconds",
})((it) => {
	it.effect(
		"the plugins file turns triggers off in the built server: its routes answer 503 and the OpenAPI document does not change",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const programs = yield* Effect.all({
					server: BuiltPrograms.path("server"),
					migrate: BuiltPrograms.path("migrate"),
					setup: BuiltPrograms.path("setup"),
					inspect: BuiltPrograms.path("inspect"),
				})
				const database = yield* PostgresTest.start
				const folder = yield* fs.makeTempDirectoryScoped()
				const pluginsFile = path.join(folder, "plugins.yml")
				yield* fs.writeFileString(
					pluginsFile,
					"- id: triggers\n  disabled: true\n",
				)
				const before = yield* fs.readFile(pluginsFile)
				const setupFile = path.join(folder, "setup.json")
				yield* fs.writeFileString(setupFile, yield* toJson(settings))
				const env = {
					OPENBOT_DATABASE_URL: database.url,
					OPENBOT_CLUSTER_SECRET:
						"test-cluster-secret-with-at-least-32-characters",
					OPENBOT_SECRET_KEYS:
						"test:1111111111111111111111111111111111111111111111111111111111111111",
					OPENBOT_HOST: "127.0.0.1",
				}

				/** Runs a program to its end, and gives its exit code and all its output. */
				const run = (
					args: ReadonlyArray<string>,
					more: Record<string, string> = {},
				) =>
					Effect.scoped(
						Effect.gen(function* () {
							const child = yield* ChildProcess.make(process.execPath, args, {
								env: { ...env, ...more },
								extendEnv: true,
								stdin: "ignore",
							})
							const [output, exitCode] = yield* Effect.all(
								[
									child.all.pipe(Stream.decodeText, Stream.mkString),
									child.exitCode,
								],
								{ concurrency: "unbounded" },
							)
							return { output, exitCode }
						}),
					)

				const migrated = yield* run([programs.migrate])
				assert.strictEqual(migrated.exitCode, 0, migrated.output)
				const setup = yield* run([programs.setup, `--config=${setupFile}`])
				assert.strictEqual(setup.exitCode, 0, setup.output)

				// A file that turns off a needed plugin stops the start with a clear line.
				const badFile = path.join(folder, "bad.yml")
				yield* fs.writeFileString(badFile, "- id: auth\n  disabled: true\n")
				const bad = yield* run([programs.server], {
					OPENBOT_PORT: String(yield* PostgresTest.freePort),
					OPENBOT_PLUGINS_FILE: badFile,
				})
				assert.notStrictEqual(bad.exitCode, 0)
				assert.include(bad.output, "The plugins file is not valid.")
				assert.include(
					bad.output,
					"This plugin is needed, so it can not be turned off.",
				)

				// Starts the server with the plugins file, and waits until it listens.
				const port = yield* PostgresTest.freePort
				const output = yield* Ref.make("")
				const ready = yield* Deferred.make<string, ProgramFailed>()
				const server = yield* ChildProcess.make(
					process.execPath,
					[programs.server],
					{
						env: {
							...env,
							OPENBOT_PORT: String(port),
							OPENBOT_PLUGINS_FILE: pluginsFile,
						},
						extendEnv: true,
						stdin: "ignore",
						killSignal: "SIGINT",
					},
				)
				yield* server.all.pipe(
					Stream.decodeText,
					Stream.runForEach((text) =>
						Effect.gen(function* () {
							const current = yield* Ref.updateAndGet(
								output,
								(all) => all + text,
							)
							const address = Option.fromNullishOr(
								/Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(current)?.[1],
							)
							if (Option.isSome(address))
								yield* Deferred.succeed(ready, address.value)
						}),
					),
					Effect.forkScoped,
				)
				yield* Effect.exit(server.exitCode).pipe(
					Effect.flatMap((exit) =>
						Effect.map(Ref.get(output), (all) =>
							ProgramFailed.make({
								reason:
									"The server ended with " +
									(Exit.isSuccess(exit) ? exit.value : "a signal"),
								output: all,
							}),
						),
					),
					Effect.flatMap((error) => Deferred.fail(ready, error)),
					Effect.forkScoped,
				)
				const address = yield* Deferred.await(ready).pipe(
					Effect.timeoutOrElse({
						duration: "30 seconds",
						orElse: () =>
							Effect.flatMap(Ref.get(output), (all) =>
								Effect.fail(
									ProgramFailed.make({
										reason: "The server did not start",
										output: all,
									}),
								),
							),
					}),
				)
				assert.include(yield* Ref.get(output), "OpenBot read the plugins file.")

				const send = (request: HttpClientRequest.HttpClientRequest) =>
					HttpClient.execute(
						request.pipe(
							HttpClientRequest.prependUrl(address),
							HttpClientRequest.setHeader("origin", settings.publicOrigin),
						),
					)

				const list = yield* send(HttpClientRequest.get("/v1/triggers"))
				assert.strictEqual(list.status, 503)
				assert.strictEqual(list.headers[FailureApi.featureHeader], "triggers")
				assert.deepStrictEqual(
					yield* Effect.flatMap(
						list.json,
						Schema.decodeUnknownEffect(Unavailable),
					),
					{ _tag: "FeatureUnavailable", feature: "triggers" },
				)
				// The webhook routes are an API group of their own. The header names that group.
				const hook = yield* send(
					HttpClientRequest.post("/v1/hooks/triggers/any").pipe(
						HttpClientRequest.bodyJsonUnsafe({ text: "Hello" }),
					),
				)
				assert.strictEqual(hook.status, 503)
				assert.strictEqual(
					hook.headers[FailureApi.featureHeader],
					"triggerHooks",
				)
				assert.deepStrictEqual(
					yield* Effect.flatMap(
						hook.json,
						Schema.decodeUnknownEffect(Unavailable),
					),
					{ _tag: "FeatureUnavailable", feature: "triggerHooks" },
				)

				// The OpenAPI document is the same as the contract and its snapshot.
				const document = yield* Effect.flatMap(
					send(HttpClientRequest.get("/openapi.json")),
					(response) => response.text,
				)
				assert.strictEqual(document, yield* toJson(OpenApi.fromApi(OpenBotApi)))
				const snapshot = yield* fs.readFileString(
					yield* path.fromFileUrl(
						new URL(
							"../../../api/test/snapshots/openapi.json",
							import.meta.url,
						),
					),
				)
				assert.strictEqual(document, snapshot)

				// The other plugins still work: a call with no session is refused, not unavailable.
				const chats = yield* send(HttpClientRequest.get("/v1/chats"))
				assert.strictEqual(chats.status, 401)
				assert.isUndefined(chats.headers[FailureApi.featureHeader])

				// Inspect prints the same hash that the running server wrote for its runner.
				const inspected = yield* run([
					programs.inspect,
					"plugins",
					`--file=${pluginsFile}`,
				])
				assert.strictEqual(inspected.exitCode, 0, inspected.output)
				const report = yield* decodeReport(inspected.output)
				assert.strictEqual(report.file, pluginsFile)
				assert.deepStrictEqual(
					Arr.findFirst(report.entries, (entry) => entry.id === "triggers"),
					Option.some({
						id: "triggers",
						disabled: true,
						changed: ["disabled"],
					}),
				)
				const rows = yield* Effect.gen(function* () {
					const sql = yield* PgClient.PgClient
					return yield* sql<{
						readonly manifest_hash: string
					}>`select manifest_hash from openbot_execution_runners`
				}).pipe(
					Effect.repeat({
						until: (found) => found.length > 0,
						times: 200,
						schedule: Schedule.spaced("50 millis"),
					}),
					Effect.provide(PgClient.layer({ url: Redacted.make(database.url) })),
				)
				assert.deepStrictEqual(
					Arr.map(rows, (row) => row.manifest_hash),
					[report.manifestHash],
				)
				// OpenBot never writes the file.
				assert.deepStrictEqual(yield* fs.readFile(pluginsFile), before)
				assert.isFalse(
					Str.includes("are not the same as on other runners")(
						yield* Ref.get(output),
					),
				)
			}).pipe(Effect.scoped),
	)
})
