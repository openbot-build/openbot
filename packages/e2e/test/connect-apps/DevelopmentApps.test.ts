import { Execution } from "@openbot-build/domain"
import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import {
	AppAuthorizationApi,
	AppExperienceApi,
	AuthApi,
	ConnectionsApi,
	ExecutionsApi,
	RequestsApi,
} from "@openbot-build/api"
import { Turn } from "@openbot-build/core"
import {
	Array as Arr,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
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
import * as Development from "@openbot-build/openbot/Development"
import { DatabasePostgres as Database } from "@openbot-build/openbot"
import {
	Caller,
	DevelopmentLogin,
	DevelopmentTesting,
	Messages,
	PostgresTest as Postgres,
	Wait,
} from "@openbot-build/openbot/testing"

const { signIn } = DevelopmentLogin
const { bot, message, model, settled } = Messages

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
					clusterSecret: Redacted.make(
						"test-cluster-secret-with-at-least-32-characters",
					),
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
				const setScenario = (
					mode: Parameters<typeof DevelopmentTesting.setScenario>[0],
				) =>
					Effect.provideContext(DevelopmentTesting.setScenario(mode), services)
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
				const runConnection = Effect.fn("DevelopmentApps.runConnection")(
					function* (
						path: string,
						kind: "verify" | "revalidate",
						payload: Schema.JsonObject = {},
					) {
						const crypto = yield* Crypto.Crypto
						const receipt = yield* post(path + "/" + kind, {
							...payload,
							commandKey: yield* crypto.randomUUIDv4(),
						}).pipe(Effect.flatMap(Caller.json(Execution.Receipt, 202)))
						const result = yield* poll(
							request(`${path}/executions/${receipt.executionId}`, "GET").pipe(
								Effect.flatMap(Caller.json(ConnectionsApi.ConnectionExecution)),
							),
							(value) => Execution.isTerminal(value.execution.status),
						)
						assert.equal(result.execution.status, "completed")
						return {
							_tag: result.result?._tag,
							connection: yield* connection(path),
						}
					},
				)
				const verify = (path: string) => runConnection(path, "verify")

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
				yield* setScenario("protocol-failure")
				assert.strictEqual(
					(yield* failedVerification(path)).availability._tag,
					"ConnectionFailed",
				)
				yield* setScenario("requirements-changed")
				const changed = yield* failedVerification(path)
				assert.strictEqual(changed.availability._tag, "NeedsRevalidation")
				const draft = yield* prepare
				yield* runConnection(path, "revalidate", {
					revision: changed.revision,
					draftId: draft.id,
					remoteIndex: 0,
					values: {},
					confirmed: true,
				})

				assert.strictEqual((yield* verify(path))._tag, "Verified")
				const account = yield* Effect.flatMap(
					request("/auth/session", "GET"),
					Caller.json(AuthApi.SessionInfo),
				)
				const executions = Effect.provideContext(
					DevelopmentTesting.executionCount(yield* Caller.memberOf(account)),
					services,
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
						commandKey: `answer-6587:${pending.id}`,
						expected: pending.revision,
						decision: "allow",
					})).status,
					202,
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
				yield* setScenario("available")
				const protectedApp = yield* add(1)
				const protectedPath = "/v1/connections/" + protectedApp.id
				const action = (id: Execution.Id) =>
					Effect.flatMap(
						request(`/v1/app-authorization-actions/${id}`, "GET"),
						Caller.json(AppAuthorizationApi.Action),
					)
				const wait = (id: Execution.Id) =>
					poll(action(id), (value) =>
						Execution.isTerminal(value.execution.status),
					)

				let authorizationCount = 0
				const authorize = Effect.fn("DevelopmentApps.authorize")(function* () {
					const current = yield* connection(protectedPath)
					const receipt = yield* Effect.flatMap(
						post(protectedPath + "/authorization", {
							commandKey: `begin:${authorizationCount++}`,
							revision: current.revision,
							scopes: ["documents"],
						}),
						Caller.json(Execution.Receipt, 202),
					)
					const started = Option.getOrThrow(
						Option.fromNullishOr((yield* wait(receipt.executionId)).result),
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
					const flow = yield* Effect.flatMap(
						request(`/v1/app-authorizations/${started.flowId}`, "GET"),
						Caller.json(AppAuthorizationApi.State),
					)
					const id = Option.getOrThrow(Option.fromNullishOr(flow.executionId))
					assert.equal((yield* wait(id)).result?._tag, "Authorized")
				})
				yield* authorize()
				assert.strictEqual((yield* verify(protectedPath))._tag, "Verified")
				yield* setScenario("authorization-expired")
				assert.strictEqual(
					(yield* failedVerification(protectedPath)).availability._tag,
					"AuthorizationExpired",
				)
				yield* authorize()
				yield* setScenario("cleanup-failure")

				const receipt = yield* Effect.flatMap(
					request(protectedPath + "/authorization", "DELETE", {
						commandKey: "development-revoke",
					}),
					Caller.json(Execution.Receipt, 202),
				)
				const pendingRevoke = yield* poll(
					action(receipt.executionId),
					(value) =>
						value.result?._tag === "RevocationPending" &&
						Arr.some(
							value.cleanupExecutions,
							(execution) => execution.status === "waiting",
						),
				)
				assert.equal(pendingRevoke.execution.status, "completed")
				assert.equal(pendingRevoke.result?._tag, "RevocationPending")
				assert.isTrue(
					Arr.some(
						pendingRevoke.cleanupExecutions,
						(execution) => execution.status === "waiting",
					),
				)
				yield* setScenario("available")
				// The durable clock can take one cluster message scan to wake the cleanup.
				const revoked = yield* Wait.untilTrue(
					"grant revoke after retry",
					action(receipt.executionId),
					(value) => value.result?._tag === "Revoked",
					{ spacing: "50 millis", times: 600 },
				)
				assert.equal(revoked.result?._tag, "Revoked")
				yield* Effect.forEach(revoked.cleanupExecutions, (execution) =>
					Effect.gen(function* () {
						const page = yield* request(
							`/v1/executions/${execution.id}/events`,
							"GET",
						).pipe(Effect.flatMap(Caller.json(ExecutionsApi.EventPage)))
						assert.isTrue(page.terminal)
						const first = Arr.findFirst(
							page.events,
							(event) =>
								event.body._tag === "StepCompleted" &&
								event.body.step === "revoke" &&
								event.body.attempt === 0,
						)
						const retry = Arr.findFirst(
							page.events,
							(event) =>
								event.body._tag === "StepStarted" &&
								event.body.step === "revoke" &&
								event.body.attempt === 1,
						)
						assert.ok(Option.isSome(first), yield* toJson(page))
						assert.ok(Option.isSome(retry), yield* toJson(page))
						assert.isAbove(retry.value.createdAt, first.value.createdAt)
					}),
				)

				const disabled = yield* connection(protectedPath)
				const enabled = yield* request(protectedPath, "PUT", {
					commandKey: "change-after-cleanup",
					revision: disabled.revision,
					name: disabled.name,
					enabled: true,
				}).pipe(Effect.flatMap(Caller.json(Execution.Receipt, 202)))
				const enabledState = yield* poll(
					request(
						`${protectedPath}/executions/${enabled.executionId}`,
						"GET",
					).pipe(
						Effect.flatMap(Caller.json(ConnectionsApi.ConnectionExecution)),
					),
					(value) => Execution.isTerminal(value.execution.status),
				)
				assert.equal(enabledState.execution.status, "completed")
				yield* authorize()
				yield* setScenario("cleanup-failure")
				const resetReceipt = yield* post("/v1/app-experience/reset", {
					commandKey: "reset",
				}).pipe(Effect.flatMap(Caller.json(Execution.Receipt, 202)))
				const reset = request(
					`/v1/app-experience/resets/${resetReceipt.executionId}`,
					"GET",
				).pipe(Effect.flatMap(Caller.json(AppExperienceApi.Reset)))
				const removed = yield* poll(reset, (value) =>
					Execution.isTerminal(value.execution.status),
				)
				assert.equal(removed.execution.status, "completed")
				assert.equal(removed.connections.length, 2)
				assert.isTrue(
					Arr.every(
						removed.connections,
						(child) => child.execution.status === "completed",
					),
				)
				assert.equal((yield* request(protectedPath, "GET")).status, 404)
				const protectedRemoval = Arr.findFirst(
					removed.connections,
					(child) => child.connectionId === protectedApp.id,
				)
				assert.ok(Option.isSome(protectedRemoval))
				const cleanup = action(protectedRemoval.value.execution.id)
				const pendingRemoval = yield* poll(cleanup, (value) =>
					Arr.some(
						value.cleanupExecutions,
						(execution) => execution.status === "waiting",
					),
				)
				assert.equal(pendingRemoval.result?._tag, "Removed")
				assert.isTrue(
					Arr.some(
						pendingRemoval.cleanupExecutions,
						(execution) => execution.status === "waiting",
					),
				)
				const replay = yield* post("/v1/app-experience/reset", {
					commandKey: "reset",
				}).pipe(Effect.flatMap(Caller.json(Execution.Receipt, 202)))
				assert.equal(replay.executionId, resetReceipt.executionId)
				const cancelled = yield* post(
					`/v1/executions/${resetReceipt.executionId}/cancel`,
					{ commandKey: "cancel-reset" },
				)
				assert.equal(
					(yield* Caller.json(Execution.Conflict, 409)(cancelled)).id,
					resetReceipt.executionId,
				)
				assert.equal((yield* reset).execution.status, "completed")
				assert.isTrue(
					Arr.every(
						(yield* cleanup).cleanupExecutions,
						(execution) => execution.status !== "cancelled",
					),
				)
				yield* setScenario("available")
				const cleaned = yield* Wait.untilTrue(
					"grant cleanup after reset",
					cleanup,
					(value) =>
						Arr.every(
							value.cleanupExecutions,
							(execution) => execution.status === "completed",
						),
					{ spacing: "50 millis", times: 600 },
				)
				assert.isTrue(
					Arr.every(
						cleaned.cleanupExecutions,
						(execution) => execution.status === "completed",
					),
				)
				const next = yield* post("/v1/app-experience/reset", {
					commandKey: "reset-again",
				}).pipe(Effect.flatMap(Caller.json(Execution.Receipt, 202)))
				const nextState = request(
					`/v1/app-experience/resets/${next.executionId}`,
					"GET",
				).pipe(Effect.flatMap(Caller.json(AppExperienceApi.Reset)))
				const finished = yield* poll(nextState, (value) =>
					Execution.isTerminal(value.execution.status),
				)
				assert.equal(finished.execution.status, "completed")
				assert.ok(
					Arr.every(
						finished.connections,
						(child) => child.execution.status === "completed",
					),
				)
				assert.equal((yield* request(protectedPath, "GET")).status, 404)
				assert.strictEqual(yield* executions, 1)
				assert.strictEqual((yield* request(chatPath, "GET")).status, 200)
			}),
		// Two saved cleanup retries each have a 30-second wait, plus setup and OAuth.
		{ timeout: 90000 },
	)
})
