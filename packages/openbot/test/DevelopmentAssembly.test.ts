import { memberOf } from "./Caller.ts"
// @effect-diagnostics strictEffectProvide:off
import * as AgentFixture from "./AgentFixture.ts"
import assert from "node:assert/strict"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { Session, Config, Model } from "@openbot-build/core"
import * as Client from "@openbot-build/client"
import { Discovery } from "@openbot-build/protocol"
import {
	SessionView,
	AppDiscoveryFailed,
	AppDiscoveryResult,
	AuthApi,
} from "@openbot-build/api"
import {
	Context,
	Data,
	Effect,
	HashMap,
	Layer,
	ManagedRuntime,
	Option,
	Redacted,
	Result,
	Schema,
	Stream,
} from "effect"
import { FetchHttpClient, HttpServer } from "effect/http"
import * as Sessions from "../src/sessions/Sessions.ts"
import * as Backend from "../dist/app/Backend.js"
import * as Development from "../dist/Development.js"
import * as Server from "../dist/app/Server.js"
import * as DevelopmentModel from "../src/app/DevelopmentModel.ts"
import * as DatabasePostgres from "../dist/database/DatabasePostgres.js"
import * as PostgresTest from "./PostgresTest.ts"
import * as DefaultAgent from "./DefaultAgent.ts"

const settings = (databaseUrl: string) => ({
	host: "127.0.0.1",
	port: 0,
	databaseUrl: Redacted.make(databaseUrl),
	secretKeys: Redacted.make(
		"test:" +
			"1111111111111111111111111111111111111111111111111111111111111111",
	),
	auth: {
		mode: "development" as const,
		publicOrigin: "https://localhost:8443",
		secret: Redacted.make("DevelopmentAssemblySecretMustRemainStable123456"),
	},
})
const wait = (
	sessions: typeof Sessions.Sessions.Service,
	id: Session.Id,
	processedMemory = false,
) => {
	const next = (
		view: SessionView,
		remaining: number,
	): Effect.Effect<SessionView, Sessions.ServiceError> =>
		Effect.gen(function* () {
			const memory = processedMemory ? yield* sessions.memory(id) : undefined
			if (
				view.activity !== "active" &&
				(memory === undefined ||
					view.state.value.conversation.history.every((entry) =>
						memory.processed.includes(entry.id),
					))
			)
				return processedMemory ? yield* sessions.get(id) : view
			assert.ok(remaining > 0, "The Session reached the expected state")
			const updated = yield* sessions.wait(
				id,
				view.session.revision,
				1000,
				view.activity,
			)
			return yield* next(updated, remaining - 1)
		})
	return sessions.get(id).pipe(Effect.flatMap((view) => next(view, 20)))
}

test(
	"development assembly streams through the API and restores processed memory after restart",
	{ timeout: 30000 },
	async () => {
		const database = await PostgresTest.start()
		const options = settings(database.url)
		const server = () => ManagedRuntime.make(Development.layer(options))
		let runtime: ReturnType<typeof server> | undefined
		try {
			await using migration = ManagedRuntime.make(
				DatabasePostgres.layer(options).pipe(Layer.provide(NodeServices.layer)),
			)
			await migration.runPromise(DatabasePostgres.migrate)
			runtime = server()
			let address = await runtime.runPromise(
				Effect.map(HttpServer.HttpServer, (server) =>
					HttpServer.formatAddress(server.address),
				),
			)
			const login = await fetch(address + "/auth/development/sign-in", {
				method: "POST",
				headers: {
					origin: options.auth.publicOrigin,
					"content-type": "application/json",
				},
				body: "{}",
			})
			assert.equal(login.status, 200)
			const cookie = login.headers
				.getSetCookie()
				.find((value) => value.startsWith(AuthApi.SessionCookie + "="))!
				.split(";")[0]!
			const headers = {
				cookie,
				origin: options.auth.publicOrigin,
				"content-type": "application/json",
			}
			await DefaultAgent.ensure((path, method, payload) =>
				fetch(address + path, {
					method,
					headers,
					...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
				}),
			)
			const created = await fetch(address + "/v1/sessions", {
				method: "POST",
				headers,
				body: JSON.stringify({}),
			})
			assert.equal(created.status, 201)
			const work = Schema.decodeUnknownSync(SessionView)(await created.json())
			assert.deepEqual(work.session.settings.model, DevelopmentModel.selection)
			const path = `/v1/sessions/${work.session.id}`
			const response = await fetch(address + path + "/turns", {
				method: "POST",
				headers,
				body: JSON.stringify({
					input: "Persist this development conversation",
					expected: work.session.revision,
					stream: true,
				}),
			})
			assert.equal(response.status, 200)
			const events = await response.text()
			assert.match(events, /response.output_text.delta/)
			assert.match(
				events,
				/Development response: Persist this development conversation/,
			)
			assert.match(events, /response.completed/)
			let saved = Schema.decodeUnknownSync(SessionView)(
				await (await fetch(address + path, { headers })).json(),
			)
			assert.equal(Session.status(saved.session)._tag, "Completed")
			const backend = await runtime.runPromise(Backend.Backend)
			const session = Schema.decodeUnknownSync(AuthApi.SessionInfo)(
				await (
					await fetch(address + "/auth/session", { headers: { cookie } })
				).json(),
			)
			const sessions = await runtime.runPromise(
				backend.forCaller({ kind: "member", ...memberOf(session) }),
			)
			saved = await runtime.runPromise(wait(sessions, work.session.id, true))
			const memory = await runtime.runPromise(sessions.memory(work.session.id))
			assert.deepEqual(memory.entries, {})
			assert.deepEqual(
				memory.processed,
				saved.state.value.conversation.history.map((entry) => entry.id),
			)
			assert.ok(memory.processed.length >= 2)
			await runtime.dispose()
			runtime = server()
			address = await runtime.runPromise(
				Effect.map(HttpServer.HttpServer, (server) =>
					HttpServer.formatAddress(server.address),
				),
			)
			const restored = Schema.decodeUnknownSync(SessionView)(
				await (await fetch(address + path, { headers })).json(),
			)
			assert.deepEqual(restored, saved)
			const continuation = await fetch(address + path + "/turns", {
				method: "POST",
				headers,
				body: JSON.stringify({
					input: "Continue once",
					stream: true,
					expected: restored.session.revision,
				}),
			})
			assert.match(
				await continuation.text(),
				/Development response: Continue once/,
			)
			let continued = Schema.decodeUnknownSync(SessionView)(
				await (await fetch(address + path, { headers })).json(),
			)
			assert.equal(
				continued.state.value.conversation.history.length,
				saved.state.value.conversation.history.length + 2,
			)
			const restartedSessions = await runtime.runPromise(
				Effect.flatMap(Backend.Backend, (backend) =>
					backend.forCaller({ kind: "member", ...memberOf(session) }),
				),
			)
			continued = await runtime.runPromise(
				wait(restartedSessions, work.session.id, true),
			)
			await runtime.runPromise(
				restartedSessions.selectModel(work.session.id, {
					expected: continued.session.revision,
					selection: Config.Selection.make({
						provider: DevelopmentModel.provider,
						model: Model.Id.make("mock-slow"),
					}),
				}),
			)
			const partial = await runtime.runPromise(
				Effect.scoped(
					Effect.flatMap(
						restartedSessions.sendStream(work.session.id, {
							expected: (
								await runtime.runPromise(restartedSessions.get(work.session.id))
							).session.revision,
							input: "Interrupt this slow response",
						}),
						(stream) =>
							stream.pipe(
								Stream.filter(
									(event) => event.event === "response.output_text.delta",
								),
								Stream.take(1),
								Stream.runCollect,
							),
					),
				),
			)
			assert.equal(partial.length, 1)
			await runtime.runPromise(
				restartedSessions.interrupt(
					work.session.id,
					Session.currentTurn(
						(await runtime.runPromise(restartedSessions.get(work.session.id)))
							.session,
					)!.id,
				),
			)
			const interrupted = await runtime.runPromise(
				wait(restartedSessions, work.session.id),
			)
			assert.equal(Session.status(interrupted.session)._tag, "Interrupted")
			assert.equal(interrupted.response?.status, "cancelled")
			await runtime.runPromise(
				restartedSessions.selectModel(work.session.id, {
					expected: interrupted.session.revision,
					selection: Config.Selection.make({
						provider: DevelopmentModel.provider,
						model: Model.Id.make("mock-failure"),
					}),
				}),
			)
			const failedEvents = await runtime.runPromise(
				Effect.scoped(
					Effect.flatMap(
						restartedSessions.sendStream(work.session.id, {
							expected: (
								await runtime.runPromise(restartedSessions.get(work.session.id))
							).session.revision,
							input: "Save this failed input",
						}),
						Stream.runCollect,
					),
				),
			)
			assert.ok(
				failedEvents.some(
					(event) => event.event === "response.output_text.delta",
				),
			)
			assert.ok(failedEvents.some((event) => event.event === "response.failed"))
			const failed = await runtime.runPromise(
				wait(restartedSessions, work.session.id),
			)
			assert.equal(Session.status(failed.session)._tag, "Failed")
			assert.equal(failed.response?.status, "failed")
			assert.match(
				JSON.stringify(failed.state.value.conversation.history),
				/Save this failed input/,
			)
			await runtime.runPromise(
				restartedSessions.selectModel(work.session.id, {
					expected: failed.session.revision,
					selection: DevelopmentModel.selection,
				}),
			)
			await runtime.runPromise(
				Effect.scoped(
					Effect.flatMap(
						restartedSessions.sendStream(work.session.id, {
							expected: (
								await runtime.runPromise(restartedSessions.get(work.session.id))
							).session.revision,
							input: "Recover after failure",
						}),
						Stream.runDrain,
					),
				),
			)
			assert.equal(
				(await runtime.runPromise(wait(restartedSessions, work.session.id)))
					.response?.status,
				"completed",
			)
		} finally {
			await runtime?.dispose()
			await database.close()
		}
	},
)

test(
	"server assembly keeps extra per-Session handlers and approvals",
	{ timeout: 30000 },
	async () => {
		const database = await PostgresTest.start()
		const options = settings(database.url)
		let calls = HashMap.empty<Session.Id, number>()
		const layer = Layer.unwrap(
			Effect.gen(function* () {
				const { builtinModels, sessions } = yield* DevelopmentModel.make
				return Server.layerFixed({
					...options,
					builtinModels,
					sessions: {
						...sessions,
						layerExecution: (ref) =>
							DevelopmentModel.toolkit.toLayer({
								DevelopmentConfirmation: ({ description }) =>
									Effect.sync(() => {
										calls = HashMap.set(
											calls,
											ref.id,
											HashMap.get(calls, ref.id).pipe(
												Option.getOrElse(() => 0),
											) + 1,
										)
										return { confirmed: `${ref.id}: ${description}` }
									}),
							}),
					},
				}).pipe(Layer.provide(DevelopmentModel.layerTools))
			}),
		)
		const runtime = ManagedRuntime.make(layer)
		try {
			await using migration = ManagedRuntime.make(
				DatabasePostgres.layer(options).pipe(Layer.provide(NodeServices.layer)),
			)
			await migration.runPromise(DatabasePostgres.migrate)
			const sessions = await runtime.runPromise(
				Effect.flatMap(Backend.Backend, (backend) =>
					backend.get("extra-tools"),
				),
			)
			const create = () =>
				runtime.runPromise(
					Effect.gen(function* () {
						const view = yield* sessions.create(AgentFixture.direct())
						return yield* sessions.selectModel(view.session.id, {
							expected: view.session.revision,
							selection: Config.Selection.make({
								provider: DevelopmentModel.provider,
								model: Model.Id.make("mock-tool"),
							}),
						})
					}),
				)
			const first = await create()
			const second = await create()
			await runtime.runPromise(
				Effect.forEach(
					[first, second],
					(view) =>
						sessions.send(view.session.id, {
							expected: view.session.revision,
							input: "Confirm independently",
						}),
					{ concurrency: "unbounded" },
				),
			)
			const waiting = await runtime.runPromise(
				Effect.forEach([first, second], (view) =>
					wait(sessions, view.session.id),
				),
			)
			assert.ok(
				waiting.every(
					(view) => Session.status(view.session)._tag === "Waiting",
				),
			)
			assert.equal(HashMap.size(calls), 0)
			const approve = async (view: SessionView, approved: boolean) => {
				const pending = await runtime.runPromise(
					sessions.waits(view.session.id),
				)
				assert.equal(pending.length, 1)
				await runtime.runPromise(
					sessions.resolveCall(
						view.session.id,
						pending[0]!.toolCallId,
						approved
							? Session.Outcome.Approved()
							: Session.Outcome.Denied({ reason: "rejected" }),
					),
				)
				return runtime.runPromise(wait(sessions, view.session.id))
			}
			const approved = await approve(waiting[0]!, true)
			const denied = await approve(waiting[1]!, false)
			assert.equal(
				HashMap.get(calls, first.session.id).pipe(Option.getOrElse(() => 0)),
				1,
			)
			assert.equal(HashMap.has(calls, second.session.id), false)
			assert.match(
				JSON.stringify(approved.response),
				new RegExp(first.session.id + ": Confirm independently"),
			)
			assert.match(
				JSON.stringify(denied.response),
				/rejected.*execution-denied/,
			)
			assert.deepEqual(
				await runtime.runPromise(sessions.waits(first.session.id)),
				[],
			)
			assert.equal(HashMap.size(calls), 1)
		} finally {
			await runtime.dispose()
			await database.close()
		}
	},
)

test("discovery injection keeps construction failures and required services", () => {
	class DiscoveryConfiguration extends Context.Service<
		DiscoveryConfiguration,
		{ readonly enabled: boolean }
	>()(
		"@openbot-build/openbot/test/DevelopmentAssembly.test/DiscoveryConfiguration",
	) {}
	class DiscoveryStartupFailed extends Data.TaggedError(
		"DiscoveryStartupFailed",
	)<{}> {}
	const injected = Layer.effect(
		Discovery.Discovery,
		Effect.gen(function* () {
			yield* DiscoveryConfiguration
			return yield* new DiscoveryStartupFailed()
		}),
	)
	const server = Server.layerFixed({
		...settings("postgresql://unused"),
		discovery: injected,
	})
	const serverDependency: DiscoveryConfiguration extends Layer.Services<
		typeof server
	>
		? true
		: false = true
	const serverFailure: DiscoveryStartupFailed extends Layer.Error<typeof server>
		? true
		: false = true
	assert.deepEqual([serverDependency, serverFailure], [true, true])
})

test(
	"development HTTP discovery uses fixed local data with standard authentication",
	{ timeout: 30000 },
	async () => {
		const database = await PostgresTest.start()
		const options = settings(database.url)
		const runtime = ManagedRuntime.make(Development.layer(options))
		try {
			await using migration = ManagedRuntime.make(
				DatabasePostgres.layer(options).pipe(Layer.provide(NodeServices.layer)),
			)
			await migration.runPromise(DatabasePostgres.migrate)
			const address = await runtime.runPromise(
				Effect.map(HttpServer.HttpServer, (server) =>
					HttpServer.formatAddress(server.address),
				),
			)
			const login = await fetch(address + "/auth/development/sign-in", {
				method: "POST",
				headers: {
					origin: options.auth.publicOrigin,
					"content-type": "application/json",
				},
				body: "{}",
			})
			assert.equal(login.status, 200)
			const cookie = login.headers
				.getSetCookie()
				.find((value) => value.startsWith(AuthApi.SessionCookie + "="))!
				.split(";")[0]!
			await using client = ManagedRuntime.make(
				Client.layer({ baseUrl: address }).pipe(
					Layer.provide(
						Layer.succeed(FetchHttpClient.Fetch, (input, init) =>
							fetch(input, {
								...init,
								headers: {
									...Object.fromEntries(new Headers(init?.headers)),
									cookie,
									origin: options.auth.publicOrigin,
								},
							}),
						),
					),
				),
			)
			const discover = (input: string) =>
				Client.Client.use((client) =>
					client.api.apps.discoverApp({ payload: { input } }),
				)
			for (const input of [
				"app.development.test",
				"https://app.development.test/card.json",
			]) {
				const result = await client.runPromise(discover(input))
				assert.ok(result._tag === "Single")
				assert.equal(
					result.candidate.cardUrl,
					"https://app.development.test/card.json",
				)
				assert.equal(
					result.candidate.card.name,
					"app.development.test/simulated-app",
				)
				assert.equal(result.candidate.sources[0]?.originalInput, input)
				assert.equal(
					result.candidate.endpoints[0]?.remote.url,
					"https://app.development.test/mcp",
				)
			}
			const failures: ReadonlyArray<readonly [string, string]> = [
				["unknown.development.test", "NoDeclaration"],
				["https://publisher.example/card.json", "NoDeclaration"],
				["http://app.development.test/card.json", "InvalidInput"],
				["https://name:secret@app.development.test/card.json", "InvalidInput"],
				["not a link", "InvalidInput"],
			]
			for (const [input, reason] of failures) {
				const result = await client.runPromise(
					discover(input).pipe(Effect.result),
				)
				assert.ok(Result.isFailure(result))
				assert.ok(Schema.is(AppDiscoveryFailed)(result.failure))
				assert.equal(result.failure.reason, reason)
			}
			const request = (
				headers: Record<string, string>,
				body = JSON.stringify({ input: "app.development.test" }),
			) =>
				fetch(address + "/v1/apps/discover", {
					method: "POST",
					headers: { "content-type": "application/json", ...headers },
					body,
				})
			for (const [headers, status] of [
				[{}, 401],
				[{ cookie }, 403],
				[{ cookie, origin: "https://foreign.development.test" }, 403],
				[
					{
						cookie: "__Host-openbot-session=invalid",
						origin: options.auth.publicOrigin,
					},
					401,
				],
			] satisfies ReadonlyArray<readonly [Record<string, string>, number]>) {
				const response = await request(headers)
				assert.equal(response.status, status)
				await response.text()
			}
			const session = await request({
				cookie,
				origin: options.auth.publicOrigin,
			})
			assert.equal(session.status, 200)
			assert.equal(
				Schema.decodeUnknownSync(Schema.toCodecJson(AppDiscoveryResult))(
					await session.json(),
				)._tag,
				"Single",
			)
			const malformed = await request(
				{ cookie, origin: options.auth.publicOrigin },
				"{",
			)
			assert.equal(malformed.status, 400)
			await malformed.text()
		} finally {
			await runtime.dispose()
			await database.close()
		}
	},
)
