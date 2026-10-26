import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import {
	AppAuthorizationApi,
	AppExperienceApi,
	AuthApi,
	ConnectionsApi,
	RequestsApi,
} from "@openbot-build/api"
import { Turn } from "@openbot-build/core"
import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Redacted,
	Schedule,
	Schema,
	String as Str,
} from "effect"
import {
	FetchHttpClient,
	Headers,
	HttpClient,
	HttpClientRequest,
	HttpServer,
} from "effect/http"
import * as Development from "../dist/Development.js"
import * as Database from "../dist/database/DatabasePostgres.js"
import { Scenarios } from "../src/app/DevelopmentScenarios.ts"
import { Business } from "../src/app/DevelopmentBusiness.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"
import * as Caller from "./Caller.ts"
import * as Postgres from "./PostgresTest.ts"
import { signIn } from "./DevelopmentLogin.ts"
import { bot, message, model, settled } from "./Messages.ts"

/** Files, programs and an HTTP client for the test. */
const platform = Layer.merge(NodeServices.layer, FetchHttpClient.layer)

/** Gives a value as JSON text. */
const toJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

/** Gives a redirect answer back as it is, in place of following it. */
const manual = Effect.provideService(FetchHttpClient.RequestInit, {
	redirect: "manual",
})

/**
 * Runs a read again, 25 milliseconds apart, until `done` holds for its value.
 * It tries again at most 200 times, and then gives the last value.
 */
const poll = <A, E, R>(
	read: Effect.Effect<A, E, R>,
	done: (value: A) => boolean,
) =>
	Effect.repeat(read, {
		until: done,
		times: 200,
		schedule: Schedule.spaced("25 millis"),
	})

// The test uses a real PostgreSQL server and a real HTTP server, so it runs in real time.
layer(platform, { excludeTestServices: true })((it) => {
	it.effect(
		"development Apps show protocol, requirement, expiry and cleanup failures through the standard APIs",
		() =>
			Effect.gen(function* () {
				const database = yield* Postgres.start
				const options = {
					host: "127.0.0.1",
					port: 0,
					databaseUrl: Redacted.make(database.url),
					secretKeys: Redacted.make("test:" + Str.repeat(32)("11")),
					auth: {
						mode: "development" as const,
						publicOrigin: "https://localhost:8443",
						secret: Redacted.make(
							"DevelopmentAppsSecretStableAcrossRestart123456789",
						),
					},
				}
				// The migration has its own database pool. It closes after the migration.
				yield* Effect.scoped(
					Effect.flatMap(Layer.build(Database.layer(options)), (services) =>
						Effect.provideContext(Database.migrate, services),
					),
				)
				const services = yield* Layer.build(Development.layer(options))
				const scenarios = Context.get(services, Scenarios)
				const business = Context.get(services, Business)
				const address = HttpServer.formatAddress(
					Context.get(services, HttpServer.HttpServer).address,
				)
				const { send: request } = yield* signIn(
					address,
					options.auth.publicOrigin,
				)
				const post = (path: string, payload?: unknown) =>
					manual(request(path, "POST", payload))
				const connection = (path: string) =>
					Effect.flatMap(
						request(path, "GET"),
						Caller.json(ConnectionsApi.Connection),
					)
				const verify = (path: string) =>
					Effect.flatMap(
						post(path + "/verify"),
						Caller.json(ConnectionsApi.Verification),
					)
				/** Verifies a connection that must fail, and gives the connection. */
				const failedVerification = Effect.fn(
					"DevelopmentApps.failedVerification",
				)(function* (path: string) {
					const result = yield* verify(path)
					assert.ok(result._tag === "Unavailable", "The verification fails")
					return result.connection
				})
				const prepare = Effect.flatMap(
					post("/v1/connection-drafts", { input: "app.development.test" }),
					Caller.json(Schema.toCodecJson(ConnectionsApi.ConnectionDraft)),
				)
				const add = Effect.fn("DevelopmentApps.add")(function* (
					remoteIndex: number,
				) {
					const draft = yield* prepare
					return yield* Effect.flatMap(
						post("/v1/connections", {
							draftId: draft.id,
							revision: draft.revision,
							cardUrl: "https://app.development.test/card.json",
							remoteIndex,
							values: {},
							name:
								remoteIndex === 0
									? "Simulated documents"
									: "Simulated private documents",
							confirmed: true,
						}),
						Caller.json(ConnectionsApi.Connection, 201),
					)
				})
				const plain = yield* add(0)
				const path = "/v1/connections/" + plain.id
				assert.strictEqual((yield* verify(path))._tag, "Verified")
				yield* scenarios.set("protocol-failure")
				assert.strictEqual(
					(yield* failedVerification(path)).availability._tag,
					"ConnectionFailed",
				)
				yield* scenarios.set("requirements-changed")
				const changed = yield* failedVerification(path)
				assert.strictEqual(changed.availability._tag, "NeedsRevalidation")
				const draft = yield* prepare
				yield* Effect.flatMap(
					post(path + "/revalidate", {
						revision: changed.revision,
						draftId: draft.id,
						remoteIndex: 0,
						values: {},
						confirmed: true,
					}),
					Caller.json(ConnectionsApi.Connection, 200),
				)
				assert.strictEqual((yield* verify(path))._tag, "Verified")
				const account = yield* Effect.flatMap(
					request("/auth/session", "GET"),
					Caller.json(AuthApi.SessionInfo),
				)
				const executions = business.executions(
					ownerKey(yield* Caller.memberOf(account)),
				)
				const appBot = yield* bot(request, {
					name: "Reader",
					model: model("mock-app"),
				})
				const first = yield* message(
					request,
					appBot,
					"Read the simulated document",
				)
				const chatPath = "/v1/chats/" + first.chat
				// The App call waits for a decision. The Turn does not wait for it.
				yield* settled(request, first.chat)
				const requests = yield* poll(
					Effect.map(
						Effect.flatMap(
							request("/v1/requests?status=pending", "GET"),
							Caller.json(Schema.Array(RequestsApi.CapabilityRequest)),
						),
						(pending) =>
							Arr.filter(pending, (entry) => entry.chat === first.chat),
					),
					Arr.isReadonlyArrayNonEmpty,
				)
				assert.strictEqual(requests.length, 1)
				assert.strictEqual(yield* executions, 0)
				const [pending] = requests
				assert.ok(pending !== undefined)
				assert.strictEqual(
					(yield* post("/v1/requests/" + pending.id, {
						expected: pending.revision,
						decision: "allow",
					})).status,
					200,
				)
				// The allowed call runs once in a new Turn of the same Chat.
				const completed = yield* poll(
					Effect.flatMap(settled(request, first.chat), (view) =>
						Effect.map(toJson(view.response), (response) => ({
							view,
							response,
						})),
					),
					({ view, response }) =>
						view.response?.status === "completed" &&
						Str.includes("handlerExecutions")(response),
				)
				assert.strictEqual(completed.view.response?.status, "completed")
				assert.match(completed.response, /handlerExecutions/)
				// The first Turn got a pending result for the call, and ended well.
				const firstTurn = yield* Effect.flatMap(
					request(chatPath + "/turns/" + first.turn, "GET"),
					Caller.json(Schema.Struct({ turn: Turn.Record })),
				)
				assert.strictEqual(firstTurn.turn.status._tag, "Completed")
				assert.strictEqual(yield* executions, 1)
				yield* scenarios.set("available")
				const protectedApp = yield* add(1)
				const protectedPath = "/v1/connections/" + protectedApp.id
				const authorize = Effect.fn("DevelopmentApps.authorize")(function* () {
					const current = yield* connection(protectedPath)
					const started = yield* Effect.flatMap(
						post(protectedPath + "/authorization", {
							revision: current.revision,
							scopes: ["documents"],
						}),
						Caller.json(AppAuthorizationApi.Started, 200),
					)
					assert.ok(started._tag === "AuthorizationStarted")
					const query = Str.slice(1)(new URL(started.authorizationUrl).search)
					const consent = yield* manual(
						HttpClient.execute(
							HttpClientRequest.post(
								address + "/development/apps/authorize",
							).pipe(
								HttpClientRequest.bodyUrlParams({ query, decision: "allow" }),
							),
						),
					)
					assert.strictEqual(consent.status, 303)
					const callback = new URL(
						yield* Effect.fromOption(Headers.get(consent.headers, "location")),
					)
					const completed = yield* manual(
						request(callback.pathname + callback.search, "GET"),
					)
					assert.strictEqual(completed.status, 303, yield* completed.text)
				})
				yield* authorize()
				assert.strictEqual((yield* verify(protectedPath))._tag, "Verified")
				yield* scenarios.set("authorization-expired")
				assert.strictEqual(
					(yield* failedVerification(protectedPath)).availability._tag,
					"AuthorizationExpired",
				)
				yield* authorize()
				yield* scenarios.set("cleanup-failure")
				const revoke = request(protectedPath + "/authorization", "DELETE")
				assert.strictEqual((yield* revoke).status, 409)
				yield* scenarios.set("available")
				assert.strictEqual(
					(yield* Effect.flatMap(
						revoke,
						Caller.json(AppAuthorizationApi.Revocation),
					))._tag,
					"Revoked",
				)
				const disabled = yield* connection(protectedPath)
				assert.strictEqual(
					(yield* request(protectedPath, "PUT", {
						revision: disabled.revision,
						name: disabled.name,
						enabled: true,
					})).status,
					200,
				)
				yield* authorize()
				yield* scenarios.set("cleanup-failure")
				const reset = (status?: number) =>
					Effect.flatMap(
						post("/v1/app-experience/reset", {}),
						Caller.json(AppExperienceApi.Reset, status),
					)
				const partial = yield* reset(200)
				assert.strictEqual(partial.removed.length, 1)
				assert.strictEqual(partial.pending.length, 1)
				assert.strictEqual(partial.pending[0]?.id, protectedApp.id)
				assert.strictEqual(
					(yield* connection(protectedPath)).availability._tag,
					"CleanupPending",
				)
				yield* scenarios.set("available")
				const finished = yield* reset()
				assert.strictEqual(finished.removed.length, 1)
				assert.deepStrictEqual(finished.pending, [])
				assert.strictEqual(yield* executions, 1)
				assert.strictEqual((yield* request(chatPath, "GET")).status, 200)
			}),
	)
})
