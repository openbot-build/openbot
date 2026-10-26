import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import {
	ChatSummary,
	AppDiscoveryFailed,
	AppDiscoveryResult,
} from "@openbot-build/api"
import {
	Deferred,
	Effect,
	Exit,
	Layer,
	Option,
	Path,
	Redacted,
	Ref,
	Schema,
	Stream,
	String as Str,
} from "effect"
import {
	FetchHttpClient,
	HttpClientResponse,
	type HttpMethod,
} from "effect/http"
import { ChildProcess } from "effect/process"
import * as Caller from "./Caller.ts"
import * as PostgresTest from "./PostgresTest.ts"
import * as DefaultBot from "./DefaultBot.ts"
import { signIn } from "./DevelopmentLogin.ts"

const publicOrigin = "https://localhost:8443"

/** A built entry ended, or did not get ready in time. */
class EntryFailed extends Schema.TaggedError<
	EntryFailed,
	{ readonly brand: unique symbol }
>()("EntryFailed", {
	entry: Schema.String,
	reason: Schema.String,
	output: Schema.String,
	errors: Schema.String,
}) {
	override get message() {
		return `${this.entry}: ${this.reason}: ${this.output}\n${this.errors}`
	}
}

const Created = Schema.Struct({ id: Schema.String })
const ModelRejected = Schema.Struct({ reason: Schema.String })
const Rejected = Schema.Struct({ _tag: Schema.String })

/** Calls the API of a running entry as the signed-in browser. */
const callAs =
	(session: Redacted.Redacted<string>, address: string) =>
	(path: string, method: HttpMethod.HttpMethod = "GET", payload?: unknown) =>
		Caller.withCookie({ address, publicOrigin })(session, path, method, payload)

// The entries are real programs with real servers, so the test needs the real clock.
layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer), {
	excludeTestServices: true,
})((it) => {
	it.effect(
		"built development entry migrates and runs, and production keeps missing-model behavior",
		() =>
			Effect.gen(function* () {
				const path = yield* Path.Path
				// The built files of this package. The tests may run from another folder.
				const dist = path.join(import.meta.dirname, "..", "dist")
				const database = yield* PostgresTest.start
				const env = {
					OPENBOT_DATABASE_URL: database.url,
					OPENBOT_SECRET_KEYS:
						"test:1111111111111111111111111111111111111111111111111111111111111111",
					OPENBOT_HOST: "127.0.0.1",
					OPENBOT_PORT: "0",
					// Only the development entry reads this. It writes the platform settings,
					// so the production entry later serves the same origin and sign-in secret.
					OPENBOT_DEV_PUBLIC_ORIGIN: publicOrigin,
				}
				/**
				 * Starts a built entry and waits until it listens. When the scope
				 * closes, the entry gets SIGINT, and the scope waits until it ends.
				 */
				const start = Effect.fn("DevelopmentEntry.start")(function* (
					entry: "DevelopmentMain" | "Main",
					readyMessage?: string,
				) {
					const port = yield* PostgresTest.freePort
					const output = yield* Ref.make("")
					const errors = yield* Ref.make("")
					const failure = (reason: string) =>
						Effect.map(
							Effect.all({ output: Ref.get(output), errors: Ref.get(errors) }),
							(logs) => EntryFailed.make({ entry, reason, ...logs }),
						)
					const ready = yield* Deferred.make<string, EntryFailed>()
					const child = yield* ChildProcess.make(
						process.execPath,
						[path.join(dist, `${entry}.js`)],
						{
							env: { ...env, OPENBOT_PORT: String(port) },
							extendEnv: true,
							stdin: "ignore",
							killSignal: "SIGINT",
						},
					)
					yield* child.stdout.pipe(
						Stream.decodeText,
						Stream.runForEach((text) =>
							Effect.gen(function* () {
								const current = yield* Ref.updateAndGet(
									output,
									(before) => before + text,
								)
								const address = Option.fromNullishOr(
									/Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(current)?.[1],
								)
								if (
									Option.isSome(address) &&
									(readyMessage === undefined ||
										Str.includes(readyMessage)(current))
								)
									yield* Deferred.succeed(ready, address.value)
							}),
						),
						Effect.forkScoped,
					)
					yield* child.stderr.pipe(
						Stream.decodeText,
						Stream.runForEach((text) =>
							Ref.update(errors, (before) => before + text),
						),
						Effect.forkScoped,
					)
					// An entry that ends before it is ready has failed.
					yield* Effect.exit(child.exitCode).pipe(
						Effect.flatMap((exit) =>
							failure(
								"Entry exited with " +
									(Exit.isSuccess(exit) ? exit.value : "a signal"),
							),
						),
						Effect.flatMap((error) => Deferred.fail(ready, error)),
						Effect.forkScoped,
					)
					const address = yield* Deferred.await(ready).pipe(
						Effect.timeoutOrElse({
							duration: "10 seconds",
							orElse: () =>
								Effect.flatMap(failure("Entry did not start"), Effect.fail),
						}),
					)
					return { address, output: Ref.get(output) }
				})
				yield* Effect.scoped(
					Effect.gen(function* () {
						const migration = yield* ChildProcess.make(
							process.execPath,
							[path.join(dist, "Migrate.js")],
							{ env, extendEnv: true, stdin: "ignore" },
						)
						const [output, exitCode] = yield* Effect.all(
							[
								migration.all.pipe(Stream.decodeText, Stream.mkString),
								migration.exitCode,
							],
							{ concurrency: "unbounded" },
						)
						assert.strictEqual(exitCode, 0, output)
					}),
				)
				const development = yield* Effect.scoped(
					Effect.gen(function* () {
						const development = yield* start(
							"DevelopmentMain",
							"Development login: POST " +
								publicOrigin +
								"/auth/development/sign-in",
						)
						const { credential: session } = yield* signIn(
							development.address,
							publicOrigin,
						)
						assert.match(
							yield* development.output,
							/Development login: POST https:\/\/localhost:8443\/auth\/development\/sign-in/,
						)
						const call = callAs(session, development.address)
						const discovered = yield* call("/v1/apps/discover", "POST", {
							input: "app.development.test",
						})
						assert.strictEqual(discovered.status, 200)
						const candidate =
							yield* HttpClientResponse.schemaBodyJson(AppDiscoveryResult)(
								discovered,
							)
						assert.ok(candidate._tag === "Single")
						assert.strictEqual(
							candidate.candidate.card.name,
							"app.development.test/simulated-app",
						)
						const unknown = yield* call("/v1/apps/discover", "POST", {
							input: "unknown.development.test",
						})
						assert.strictEqual(unknown.status, 422)
						assert.strictEqual(
							(yield* HttpClientResponse.schemaBodyJson(AppDiscoveryFailed)(
								unknown,
							)).reason,
							"NoDeclaration",
						)
						const bot = yield* DefaultBot.ensure(call)
						const answer = yield* call(`/v1/bots/${bot}/messages`, "POST", {
							input: "Verify the built entry",
							stream: true,
						})
						assert.strictEqual(answer.status, 200)
						assert.match(
							yield* answer.text,
							/Development response: Verify the built entry/,
						)
						// The development platform gives the new direct Chat a simulated model.
						const [chat] = yield* Effect.flatMap(
							call(`/v1/chats?bot=${bot}`),
							HttpClientResponse.schemaBodyJson(Schema.Array(ChatSummary)),
						)
						assert.ok(chat !== undefined)
						const simulatedModel = chat.chat.settings.model
						assert.ok(simulatedModel !== undefined)
						return { session, simulatedModel }
					}),
				)
				yield* Effect.scoped(
					Effect.gen(function* () {
						const production = yield* start("Main")
						const call = callAs(development.session, production.address)
						const blocked = yield* call("/v1/apps/discover", "POST", {
							input: "https://127.0.0.1/card.json",
						})
						assert.strictEqual(blocked.status, 422)
						assert.strictEqual(
							(yield* HttpClientResponse.schemaBodyJson(AppDiscoveryFailed)(
								blocked,
							)).reason,
							"BlockedTarget",
						)
						// Production has no default model and no simulated models.
						const talkTo = Effect.fnUntraced(function* (model?: object) {
							const created = yield* call("/v1/bots", "POST", {
								name: "Production helper",
								role: "Helps in production",
								instructions: "Help the person.",
								...(model === undefined ? {} : { model }),
							})
							assert.strictEqual(created.status, 201, yield* created.text)
							const { id } =
								yield* HttpClientResponse.schemaBodyJson(Created)(created)
							return yield* call(`/v1/bots/${id}/messages`, "POST", {
								input: "Hello",
							})
						})
						const withoutModel = yield* talkTo()
						assert.strictEqual(withoutModel.status, 400)
						assert.strictEqual(
							(yield* HttpClientResponse.schemaBodyJson(ModelRejected)(
								withoutModel,
							)).reason,
							"missing",
						)
						const simulated = yield* talkTo(development.simulatedModel)
						assert.strictEqual(simulated.status, 400)
						assert.strictEqual(
							(yield* HttpClientResponse.schemaBodyJson(Rejected)(simulated))
								._tag,
							"ChatModelInvalid",
						)
						assert.strictEqual(
							Str.includes("Development login:")(yield* production.output),
							false,
						)
					}),
				)
			}),
	)
})
