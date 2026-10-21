// @effect-diagnostics strictEffectProvide:off
import { PgClient } from "@effect/sql-pg"
import { Client as PgConnection } from "pg"
import { Requests } from "../src/capabilities/Requests.ts"
import { Signal, Signals } from "../src/agents/Signals.ts"
import assert from "node:assert/strict"
import { test } from "node:test"
import { request as requestHttp } from "node:http"
import { AppExecution, RequestsApi, SessionView } from "@openbot-build/api"
import { Client } from "@openbot-build/protocol"
import { AppHost } from "../src/apps/AppHost.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"
import { Invocations } from "../src/apps/Invocations.ts"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { Effect, Layer, Match, Option, Redacted, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/ai"
import { HttpClient, HttpClientResponse } from "effect/http"
import {
	Config,
	ContextWindow,
	Model,
	Provider,
	Session,
	SessionStoreRepository,
	Store,
} from "@openbot-build/core"
import * as Memory from "../src/plugins/memory/Memory.ts"
import * as StoredSessions from "../src/sessions/StoredSessions.ts"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import * as OpenAiCompatProvider from "../src/providers/openai-compat/OpenAiCompatProvider.ts"
import { AppNetwork } from "../src/apps/AppHost.ts"
import { startHttps } from "../../protocol/test/Fixture.ts"
import * as Fixture from "./AppFixture.ts"
import * as BrowserHost from "./BrowserHost.ts"

const start = async (
	options: {
		readonly write?: boolean
		readonly callId?: () => string
		readonly sameTurnWrites?: number
		readonly readPolicy?: boolean
		readonly repeatArguments?: boolean
		readonly refreshToken?: boolean
		readonly scopes?: ReadonlyArray<string>
	} = {},
) => {
	let address = ""
	let preparedTools: ReadonlyArray<Tool.Any> = []
	const proxy = await startHttps((request, response) => {
		const upstream = requestHttp(
			new URL(request.url ?? "/", address),
			{ method: request.method, headers: request.headers },
			(result) => {
				response.writeHead(result.statusCode ?? 500, result.headers)
				result.pipe(response)
			},
		)
		upstream.on("error", () => {
			response.writeHead(502)
			response.end()
		})
		request.pipe(upstream)
	})
	const publisher = await Fixture.start({
		capabilities: true,
		rotateRefreshToken: true,
		...(options.scopes === undefined ? {} : { scopes: options.scopes }),
		...(options.refreshToken === undefined
			? {}
			: { refreshToken: options.refreshToken }),
	})
	const usage = {
		inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 1, text: 1, reasoning: 0 },
	}
	const model = await Effect.runPromise(
		LanguageModel.make({
			generateText: () => Effect.succeed([]),
			streamText: ({ prompt, tools }) =>
				Stream.suspend((): Stream.Stream<Response.StreamPartEncoded> => {
					preparedTools = tools
					const last = prompt.content.findLastIndex(
						(message) => message.role === "user",
					)
					const results = prompt.content.slice(last + 1).flatMap((message) =>
						Match.value(message).pipe(
							Match.when({ role: "tool" }, (message) =>
								message.content.filter((part) => part.type === "tool-result"),
							),
							Match.orElse(() => []),
						),
					)
					if (results.length >= (options.sameTurnWrites ?? 1))
						return Stream.make(
							Response.makePart("text-start", { id: "answer" }),
							Response.makePart("text-delta", {
								id: "answer",
								delta: JSON.stringify(results.at(-1)?.result),
							}),
							Response.makePart("text-end", { id: "answer" }),
							Response.makePart("finish", { reason: "stop", usage }),
						)
					const calls = prompt.content.slice(last + 1).flatMap((message) =>
						Match.value(message).pipe(
							Match.when({ role: "assistant" }, (message) =>
								message.content.filter((part) => part.type === "tool-call"),
							),
							Match.orElse(() => []),
						),
					)
					assert.ok(
						calls.length <= results.length,
						"An approved App call must produce its result without the model resubmitting it",
					)

					const tool = tools.find((tool) =>
						tool.description?.includes(
							options.write === true ? " / write_board." : " / read_later.",
						),
					)
					assert.ok(
						tool,
						"The authorized App must expose the requested capability",
					)
					return Stream.make(
						Response.makePart("tool-call", {
							id: options.callId?.() ?? "approved-read",
							name: tool.name,
							params:
								options.write === true
									? {
											id: "release-plan",
											text:
												options.sameTurnWrites === undefined
													? "Approved content"
													: `Approved content ${options.repeatArguments === true ? 1 : results.length + 1}`,
										}
									: { id: "release-plan" },
							providerExecuted: false,
						}),
						Response.makePart("finish", { reason: "tool-calls", usage }),
					)
				}),
		}),
	)
	const sessionCookie = "__Host-app-fixture-session"
	const host = await BrowserHost.start({
		authCompatibility: { sessionCookie },
		publicOrigin: proxy.ipOrigin,
		model,
		discovery: publisher.discovery,
		appReadRules:
			options.readPolicy === true
				? [{ cardUrl: publisher.origin + "/card", tool: "read_later" }]
				: [],
		appProbe: publisher.probe,
		appNetwork: Layer.succeed(AppNetwork, {
			layer: (owner, origins) =>
				NodeHttpServer.layerUserNetwork({
					owner,
					allowedOrigins: origins,
					allowAddress: (ip) => ip === "127.0.0.1",
					ca: [proxy.ca, publisher.ca],
				}),
		}),
	})
	address = host.address
	try {
		const user = await host.login("app-recovery-user")
		const headers = {
			cookie:
				sessionCookie + "=" + encodeURIComponent(Redacted.value(user.session)),
			origin: proxy.ipOrigin,
			"content-type": "application/json",
		}
		const post = (path: string, body: unknown) =>
			fetch(host.address + path, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				redirect: "manual",
			})
		const get = async (path: string) => {
			const response = await fetch(host.address + path, { headers })
			assert.equal(response.status, 200, await response.clone().text())
			return response.json()
		}
		const draft = await (
			await post("/v1/connection-drafts", { input: publisher.origin + "/card" })
		).json()
		const saved = await post("/v1/connections", {
			draftId: draft.id,
			revision: draft.revision,
			cardUrl: publisher.origin + "/card",
			remoteIndex: 1,
			name: "Recovery documents",
			values: {},
			confirmed: true,
		})
		assert.equal(saved.status, 201, await saved.clone().text())
		const connection = await saved.json()
		const began = await post(`/v1/connections/${connection.id}/authorization`, {
			revision: connection.revision,
			scopes: options.scopes ?? ["documents"],
		})
		assert.equal(began.status, 200, await began.clone().text())
		const flow = await began.json()
		const callback = new URL(publisher.issueCode(flow.authorizationUrl))
		const accepted = await fetch(
			host.address + callback.pathname + callback.search,
			{ headers, redirect: "manual" },
		)
		assert.equal(accepted.status, 303, await accepted.clone().text())
		const connected = await get(`/v1/connections/${connection.id}`)
		const created = await post("/v1/sessions", {})
		assert.equal(created.status, 201)
		const session = Schema.decodeUnknownSync(SessionView)(await created.json())
			.session.id
		const view = async () =>
			Schema.decodeUnknownSync(SessionView)(
				await get(`/v1/sessions/${session}`),
			)
		const wait = async () => {
			let current = await view()
			for (
				let attempt = 0;
				current.activity === "active" && attempt < 30;
				attempt++
			) {
				current = Schema.decodeUnknownSync(SessionView)(
					await get(
						`/v1/sessions/${session}/wait?` +
							new URLSearchParams({
								after: String(current.session.revision),
								afterActivity: current.activity,
								timeoutMs: "1000",
							}),
					),
				)
			}
			assert.notEqual(current.activity, "active")
			return current
		}
		const requests = async () => {
			for (let attempt = 0; attempt < 200; attempt++) {
				const current = await wait()
				if (Session.status(current.session)._tag !== "Waiting") return []
				const list = Schema.decodeUnknownSync(
					Schema.Array(RequestsApi.CapabilityRequest),
				)(await get("/v1/requests?status=pending")).filter(
					(entry) =>
						entry.session === session &&
						entry.turn === Session.currentTurn(current.session)?.id,
				)
				if (list.length > 0)
					return list.map((entry) => {
						assert.ok(entry.app)
						return { ...entry, app: entry.app }
					})
				await new Promise((resolve) => setTimeout(resolve, 25))
			}
			throw new Error("The waiting Turn did not publish its request")
		}
		const decide = async (
			request: RequestsApi.CapabilityRequest,
			approved: boolean,
			grantReads = false,
		) => {
			const before = await view()
			const response = await post(`/v1/requests/${request.id}`, {
				expected: request.revision,
				decision: approved ? "allow" : "deny",
				expectedSessionRevision: before.session.revision,
				grantReads,
			})
			if (response.status === 200) {
				for (let attempt = 0; attempt < 200; attempt++) {
					const current = await view()
					if (current.session.revision > before.session.revision)
						return response
					await new Promise((resolve) => setTimeout(resolve, 25))
				}
				throw new Error("The request decision did not reach the waiting Turn")
			}
			return response
		}
		return {
			requests,
			decide,
			host,
			publisher,
			user,
			headers,
			post,
			get,
			view,
			wait,
			session,
			connected,
			tools: () => preparedTools,
			omitContextResult: (callId: string) =>
				host.runtime.runPromise(
					Effect.scoped(
						Effect.gen(function* () {
							const db = yield* makeWithDefaults()
							const definition = yield* Store.define({
								stores: Memory.stores,
								schemaVersion: "timeline/1",
							})
							const store = yield* SessionStoreRepository.make({
								definition,
								persistence: StoredSessions.persistence(
									db,
									JSON.stringify([
										user.identity.organizationId,
										user.identity.userId,
									]),
								),
							})
							yield* store.modifyEffect({
								session,
								update: (view) =>
									Effect.succeed([
										undefined,
										Option.some({
											value: {
												...view.state.value,
												conversation: {
													...view.state.value.conversation,
													context: ContextWindow.fromPrompt(
														Prompt.fromMessages(
															view.state.value.conversation.context.prompt.content.filter(
																(message) =>
																	!Match.value(message).pipe(
																		Match.when({ role: "tool" }, (message) =>
																			message.content.some(
																				(part) =>
																					part.type === "tool-result" &&
																					part.id === callId,
																			),
																		),
																		Match.orElse(() => false),
																	),
															),
														),
													),
												},
											},
										}),
									]),
							})
						}),
					),
				),
			restart: async () => {
				await host.restart()
				address = host.address
			},
			close: async () => {
				await host.close()
				await publisher.close()
				await proxy.close()
			},
		}
	} catch (error) {
		await host.close()
		await publisher.close()
		await proxy.close()
		throw error
	}
}

test("an App token expiring during approval is renewed and the original call executes once", async (t) => {
	const fixture = await start()
	try {
		const current = await fixture.view()
		const started = await fixture.post(
			`/v1/sessions/${fixture.session}/turns`,
			{
				input: "Read the approved document",
				expected: current.session.revision,
			},
		)
		assert.equal(started.status, 202)
		await fixture.wait()
		const approvals = await fixture.requests()
		assert.equal(approvals.length, 1)
		assert.equal(fixture.publisher.businessCalls(), 0)
		t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
		t.mock.timers.tick(61 * 60 * 1000)
		const approval = approvals[0]
		assert.ok(approval)
		const accepted = await fixture.decide(approval, true)
		assert.equal(accepted.status, 200, await accepted.clone().text())
		const completed = await fixture.wait()
		assert.equal(
			completed.response?.status,
			"completed",
			JSON.stringify(completed.response),
		)
		assert.match(
			JSON.stringify(completed.response),
			/Document content release-plan/,
		)
		assert.equal(fixture.publisher.exchanges(), 2)
		assert.equal(fixture.publisher.businessCalls(), 1)
		assert.equal(
			(await fixture.get(`/v1/connections/${fixture.connected.id}`)).revision,
			fixture.connected.revision,
		)
		const operations = Schema.decodeUnknownSync(
			Schema.Array(AppExecution.Invocation),
		)(await fixture.get(`/v1/sessions/${fixture.session}/app-operations`))
		assert.equal(operations.length, 1)
		assert.equal(operations[0]?.status, "Completed")
		assert.equal(operations[0]?.callId, approval.app.callId)
	} finally {
		await fixture.close()
	}
})

test("failed renewal returns an App authorization result without executing the approved call", async (t) => {
	const fixture = await start()
	try {
		const current = await fixture.view()
		assert.equal(
			(
				await fixture.post(`/v1/sessions/${fixture.session}/turns`, {
					input: "Read the approved document",
					expected: current.session.revision,
				})
			).status,
			202,
		)
		await fixture.wait()
		const [approval] = await fixture.requests()
		assert.ok(approval)
		fixture.publisher.setRejectGrant(true)
		t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
		t.mock.timers.tick(61 * 60 * 1000)
		assert.equal((await fixture.decide(approval, true)).status, 200)
		const completed = await fixture.wait()
		assert.equal(
			completed.response?.status,
			"completed",
			JSON.stringify(completed.response),
		)
		assert.match(JSON.stringify(completed.response), /AuthorizationRequired/)
		assert.equal(fixture.publisher.businessCalls(), 0)
		const operations = Schema.decodeUnknownSync(
			Schema.Array(AppExecution.Invocation),
		)(await fixture.get(`/v1/sessions/${fixture.session}/app-operations`))
		assert.equal(operations.length, 1)
		assert.equal(operations[0]?.status, "Failed")
		assert.equal(operations[0]?.result?._tag, "Failed")
	} finally {
		await fixture.close()
	}
})

test("an uncertain write remains observable after renewal and runtime restart without resubmission", async (t) => {
	const fixture = await start({ write: true })
	try {
		const current = await fixture.view()
		assert.equal(
			(
				await fixture.post(`/v1/sessions/${fixture.session}/turns`, {
					input: "Write the approved document",
					expected: current.session.revision,
				})
			).status,
			202,
		)
		await fixture.wait()
		const [approval] = await fixture.requests()
		assert.ok(approval)
		fixture.publisher.setDropResult(true)
		assert.equal((await fixture.decide(approval, true)).status, 200)
		const ended = await fixture.wait()
		assert.equal(ended.response?.status, "completed")
		assert.match(JSON.stringify(ended.response), /OutcomeUnknown/)
		assert.equal(fixture.publisher.writes().length, 1)
		fixture.publisher.setDropResult(false)
		await fixture.restart()
		t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
		t.mock.timers.tick(61 * 60 * 1000)
		const [saved] = Schema.decodeUnknownSync(
			Schema.Array(AppExecution.Invocation),
		)(await fixture.get(`/v1/sessions/${fixture.session}/app-operations`))
		assert.ok(saved)
		assert.equal(saved.status, "OutcomeUnknown")
		const observed = await fixture.host.runtime.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const owner = ownerKey(fixture.user.identity)
					const app = (yield* AppHost).bind(
						owner,
						Client.InvocationPolicy.of({ check: () => Effect.void }),
					)
					yield* app.open({
						key: { owner, connectionId: fixture.connected.id },
						clientInfo: { name: "Recovery test", version: "1" },
					})
					return yield* (yield* Invocations).execute(
						{
							owner,
							session: fixture.session,
							turn: saved.turn,
							callId: saved.callId,
							toolName: saved.toolName,
							source: saved.source,
							arguments: saved.arguments,
						},
						Effect.die("An uncertain write must never be submitted again"),
					)
				}),
			),
		)
		assert.equal(observed._tag, "Failed")
		assert.match(JSON.stringify(observed), /OutcomeUnknown/)
		assert.equal(observed.operationId, saved.id)
		assert.equal(fixture.publisher.exchanges(), 2)
		assert.equal(fixture.publisher.writes().length, 1)
		assert.equal(fixture.publisher.businessCalls(), 1)
		await fixture.omitContextResult(saved.callId)
		const continued = await fixture.view()
		assert.equal(
			(
				await fixture.post(`/v1/sessions/${fixture.session}/turns`, {
					input: "A separate operation after observing the uncertain write",
					expected: continued.session.revision,
				})
			).status,
			202,
		)
		await fixture.wait()
		const approvals = await fixture.requests()
		assert.equal(approvals.length, 1)
		assert.ok(approvals[0])
		assert.notEqual(approvals[0].turn, saved.turn)
		assert.equal(fixture.publisher.writes().length, 1)
		assert.equal(fixture.publisher.businessCalls(), 1)
		const retained = Schema.decodeUnknownSync(
			Schema.Array(AppExecution.Invocation),
		)(await fixture.get(`/v1/sessions/${fixture.session}/app-operations`)).find(
			(value) => value.id === saved.id,
		)
		assert.equal(retained?.status, "OutcomeUnknown")
		assert.equal(retained?.callId, saved.callId)
		assert.equal(
			(
				await fixture.post(
					`/v1/sessions/${fixture.session}/turns/${approvals[0].turn}/interrupt`,
					{},
				)
			).status,
			200,
		)
		await fixture.wait()
		assert.equal(fixture.publisher.writes().length, 1)
	} finally {
		await fixture.close()
	}
})

test("concurrent opens renew an expired connection once while real configuration changes invalidate its version", async (t) => {
	const fixture = await start()
	try {
		fixture.publisher.setTokenDelay(50)
		t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
		t.mock.timers.tick(61 * 60 * 1000)
		await Promise.all(
			[0, 1].map(() =>
				fixture.host.runtime.runPromise(
					Effect.scoped(
						Effect.gen(function* () {
							const owner = ownerKey(fixture.user.identity)
							const client = yield* (yield* AppHost)
								.bind(
									owner,
									Client.InvocationPolicy.of({ check: () => Effect.void }),
								)
								.open({
									key: { owner, connectionId: fixture.connected.id },
									clientInfo: { name: "Concurrent recovery", version: "1" },
								})
							assert.ok((yield* client.listTools()).tools.length > 0)
						}),
					),
				),
			),
		)
		assert.equal(fixture.publisher.exchanges(), 2)
		assert.equal(fixture.publisher.maxTokenRequests(), 1)
		assert.equal(fixture.publisher.businessCalls(), 0)
		const current = await fixture.get(`/v1/connections/${fixture.connected.id}`)
		assert.equal(current.revision, fixture.connected.revision)
		const renamed = await fetch(
			fixture.host.address + `/v1/connections/${current.id}`,
			{
				method: "PUT",
				headers: fixture.headers,
				body: JSON.stringify({
					revision: current.revision,
					name: "Changed connection",
					enabled: true,
				}),
			},
		)
		assert.equal(renamed.status, 200)
		assert.equal((await renamed.json()).revision, current.revision + 1)
	} finally {
		await fixture.close()
	}
})

for (const mode of ["missing-refresh", "changed-tool"] as const)
	test(`an approved operation with ${mode} remains identifiable without sending business calls`, async (t) => {
		const fixture = await start({ refreshToken: mode !== "missing-refresh" })
		try {
			const current = await fixture.view()
			assert.equal(
				(
					await fixture.post(`/v1/sessions/${fixture.session}/turns`, {
						input: "Read the approved document",
						expected: current.session.revision,
					})
				).status,
				202,
			)
			await fixture.wait()
			const [approval] = await fixture.requests()
			assert.ok(approval)
			assert.ok(approval)
			Match.value(mode).pipe(
				Match.when("missing-refresh", () => {
					t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
					t.mock.timers.tick(61 * 60 * 1000)
				}),
				Match.when("changed-tool", () =>
					fixture.publisher.setToolDescription("A changed document operation"),
				),
				Match.exhaustive,
			)
			assert.equal((await fixture.decide(approval, true)).status, 200)
			const ended = await fixture.wait()
			assert.equal(
				ended.response?.status,
				"completed",
				JSON.stringify(ended.response),
			)
			assert.match(
				JSON.stringify(ended.response),
				mode === "missing-refresh"
					? /AuthorizationRequired/
					: /CapabilityUnavailable/,
			)
			assert.equal(fixture.publisher.businessCalls(), 0)
			assert.equal(fixture.publisher.exchanges(), 1)
			const [record] = Schema.decodeUnknownSync(
				Schema.Array(AppExecution.Invocation),
			)(await fixture.get(`/v1/sessions/${fixture.session}/app-operations`))
			assert.equal(record?.status, "Failed")
			assert.equal(record?.toolName, approval.app.toolName)
		} finally {
			await fixture.close()
		}
	})

for (const mode of ["completed", "receipt-unavailable"] as const)
	test(`a ${mode} write is observed from its original record and is never sent twice`, async () => {
		const fixture = await start({ write: true })
		try {
			if (mode === "receipt-unavailable")
				await fixture.host.runtime.runPromise(
					Effect.gen(function* () {
						const sql = yield* PgClient.PgClient
						yield* sql`create function reject_recovery_receipt() returns trigger language plpgsql as $$ begin if OLD.status = 'Sending' and NEW.status <> 'Sending' then raise exception 'Fixture receipt storage unavailable'; end if; return NEW; end $$`
						yield* sql`create trigger reject_recovery_receipt before update on openbot_app_invocations for each row execute function reject_recovery_receipt()`
					}),
				)
			const current = await fixture.view()
			assert.equal(
				(
					await fixture.post(`/v1/sessions/${fixture.session}/turns`, {
						input: "Write the approved document",
						expected: current.session.revision,
					})
				).status,
				202,
			)
			await fixture.wait()
			const [approval] = await fixture.requests()
			assert.ok(approval)
			assert.equal((await fixture.decide(approval, true)).status, 200)
			const ended = await fixture.wait()
			assert.equal(ended.response?.status, "completed")
			assert.equal(fixture.publisher.writes().length, 1)
			const [saved] = Schema.decodeUnknownSync(
				Schema.Array(AppExecution.Invocation),
			)(await fixture.get(`/v1/sessions/${fixture.session}/app-operations`))
			assert.ok(saved)
			assert.equal(saved.status, mode === "completed" ? "Completed" : "Sending")
			const input = {
				owner: ownerKey(fixture.user.identity),
				session: fixture.session,
				turn: saved.turn,
				callId: saved.callId,
				toolName: saved.toolName,
				source: saved.source,
				arguments: saved.arguments,
			}
			const observe = () =>
				fixture.host.runtime.runPromise(
					Effect.flatMap(Invocations, (service) =>
						service.execute(
							input,
							Effect.die(
								"An already-sent operation must never be submitted again",
							),
						),
					),
				)
			const observed = await observe()
			Match.value(mode).pipe(
				Match.when("completed", () => assert.deepEqual(observed, saved.result)),
				Match.when("receipt-unavailable", () =>
					assert.match(JSON.stringify(observed), /OutcomeUnknown/),
				),
				Match.exhaustive,
			)
			const mismatched = await fixture.host.runtime.runPromise(
				Effect.flatMap(Invocations, (service) =>
					service.execute(
						{
							...input,
							arguments: { ...input.arguments, text: "Different intent" },
						},
						Effect.die("Changed parameters must not execute"),
					),
				).pipe(Effect.result),
			)
			assert.equal(mismatched._tag, "Failure")
			if (mode === "receipt-unavailable")
				await fixture.host.runtime.runPromise(
					Effect.gen(function* () {
						const sql = yield* PgClient.PgClient
						yield* sql`drop trigger reject_recovery_receipt on openbot_app_invocations`
						yield* sql`drop function reject_recovery_receipt()`
					}),
				)
			await fixture.restart()
			assert.deepEqual(await observe(), observed)
			assert.equal(fixture.publisher.writes().length, 1)
			assert.equal(fixture.publisher.businessCalls(), 1)
		} finally {
			await fixture.close()
		}
	})

test("explicit reauthorization invalidates pending approval even when issuer and scopes are unchanged", async () => {
	const fixture = await start({ write: true })
	try {
		const current = await fixture.view()
		assert.equal(
			(
				await fixture.post(`/v1/sessions/${fixture.session}/turns`, {
					input: "Write the approved document",
					expected: current.session.revision,
				})
			).status,
			202,
		)
		await fixture.wait()
		const [approval] = await fixture.requests()
		assert.ok(approval)
		const before = await fixture.get(`/v1/connections/${fixture.connected.id}`)
		const started = await fixture.post(
			`/v1/connections/${fixture.connected.id}/authorization`,
			{ revision: before.revision, scopes: ["documents"] },
		)
		assert.equal(started.status, 200)
		const flow = await started.json()
		const callback = new URL(fixture.publisher.issueCode(flow.authorizationUrl))
		assert.equal(
			(
				await fetch(
					fixture.host.address + callback.pathname + callback.search,
					{ headers: fixture.headers, redirect: "manual" },
				)
			).status,
			303,
		)
		const after = await fixture.get(`/v1/connections/${fixture.connected.id}`)
		assert.equal(after.revision, before.revision + 1)
		assert.equal((await fixture.decide(approval, true)).status, 409)
		assert.equal(fixture.publisher.businessCalls(), 0)
		assert.equal(fixture.publisher.writes().length, 0)
	} finally {
		await fixture.close()
	}
})

test("stopping a Turn during refresh preserves rotated credentials without sending its write", async (t) => {
	const fixture = await start({ write: true })
	try {
		const current = await fixture.view()
		assert.equal(
			(
				await fixture.post(`/v1/sessions/${fixture.session}/turns`, {
					input: "Write the approved document",
					expected: current.session.revision,
				})
			).status,
			202,
		)
		await fixture.wait()
		const [approval] = await fixture.requests()
		assert.ok(approval)
		fixture.publisher.setTokenDelay(500)
		t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
		t.mock.timers.tick(61 * 60 * 1000)
		assert.equal((await fixture.decide(approval, true)).status, 200)
		for (
			let attempt = 0;
			fixture.publisher.exchanges() < 2 && attempt < 100;
			attempt++
		)
			await new Promise((resolve) => setTimeout(resolve, 10))
		assert.equal(fixture.publisher.exchanges(), 2)
		assert.equal(
			(
				await fixture.post(
					`/v1/sessions/${fixture.session}/turns/${approval.turn}/interrupt`,
					{},
				)
			).status,
			200,
		)
		const stopped = await fixture.wait()
		assert.notEqual(stopped.response?.status, "completed")
		assert.equal(fixture.publisher.businessCalls(), 0)
		assert.equal(fixture.publisher.writes().length, 0)
		await fixture.restart()
		const open = () =>
			fixture.host.runtime.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const owner = ownerKey(fixture.user.identity)
						const app = (yield* AppHost).bind(
							owner,
							Client.InvocationPolicy.of({ check: () => Effect.void }),
						)
						yield* app.open({
							key: { owner, connectionId: fixture.connected.id },
							clientInfo: { name: "Cancellation recovery", version: "1" },
						})
					}),
				),
			)
		await open()
		assert.equal(fixture.publisher.exchanges(), 2)
		fixture.publisher.setTokenDelay(0)
		t.mock.timers.tick(61 * 60 * 1000)
		await open()
		assert.equal(fixture.publisher.exchanges(), 3)
		assert.equal(fixture.publisher.businessCalls(), 0)
		assert.equal(fixture.publisher.writes().length, 0)
	} finally {
		await fixture.close()
	}
})

test("equivalent scopes in a different order preserve the approved operation", async (t) => {
	const fixture = await start({ scopes: ["documents", "profile"] })
	try {
		const current = await fixture.view()
		assert.equal(
			(
				await fixture.post(`/v1/sessions/${fixture.session}/turns`, {
					input: "Read the approved document",
					expected: current.session.revision,
				})
			).status,
			202,
		)
		await fixture.wait()
		const [approval] = await fixture.requests()
		assert.ok(approval)
		fixture.publisher.setGrantedScope("profile documents")
		t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
		t.mock.timers.tick(61 * 60 * 1000)
		assert.equal((await fixture.decide(approval, true)).status, 200)
		const completed = await fixture.wait()
		assert.equal(completed.response?.status, "completed")
		assert.match(
			JSON.stringify(completed.response),
			/Document content release-plan/,
		)
		const connection = await fixture.get(
			`/v1/connections/${fixture.connected.id}`,
		)
		assert.equal(connection.revision, fixture.connected.revision)
		assert.equal(fixture.publisher.exchanges(), 2)
		assert.equal(fixture.publisher.businessCalls(), 1)
	} finally {
		await fixture.close()
	}
})

for (const change of [
	{
		label: "narrower",
		scopes: "documents",
		revisionDelta: 1,
		reason: "PermissionDenied",
	},
	{
		label: "broader",
		scopes: "documents profile admin",
		revisionDelta: 0,
		reason: "AuthorizationRequired",
	},
])
	test(`a ${change.label} refreshed scope set cannot reuse the approved write`, async (t) => {
		const fixture = await start({
			write: true,
			scopes: ["documents", "profile"],
		})
		try {
			const current = await fixture.view()
			assert.equal(
				(
					await fixture.post(`/v1/sessions/${fixture.session}/turns`, {
						input: "Write the approved document",
						expected: current.session.revision,
					})
				).status,
				202,
			)
			await fixture.wait()
			const [approval] = await fixture.requests()
			assert.ok(approval)
			fixture.publisher.setGrantedScope(change.scopes)
			t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
			t.mock.timers.tick(61 * 60 * 1000)
			assert.equal((await fixture.decide(approval, true)).status, 200)
			const completed = await fixture.wait()
			assert.equal(completed.response?.status, "completed")
			assert.ok(JSON.stringify(completed.response).includes(change.reason))
			const connection = await fixture.get(
				`/v1/connections/${fixture.connected.id}`,
			)
			assert.equal(
				connection.revision,
				fixture.connected.revision + change.revisionDelta,
			)
			assert.equal(fixture.publisher.exchanges(), 2)
			assert.equal(fixture.publisher.businessCalls(), 0)
			assert.equal(fixture.publisher.writes().length, 0)
		} finally {
			await fixture.close()
		}
	})

test("recovered operations remain compatible with the production provider schema mode", async (t) => {
	const fixture = await start({ write: true, refreshToken: false })
	try {
		const current = await fixture.view()
		assert.equal(
			(
				await fixture.post(`/v1/sessions/${fixture.session}/turns`, {
					input: "Write the approved document",
					expected: current.session.revision,
				})
			).status,
			202,
		)
		await fixture.wait()
		const [approval] = await fixture.requests()
		assert.ok(approval)
		const original = fixture
			.tools()
			.find((tool) => tool.name === approval.app.toolName)
		assert.ok(original)
		t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
		t.mock.timers.tick(61 * 60 * 1000)
		assert.equal((await fixture.decide(approval, true)).status, 200)
		const completed = await fixture.wait()
		assert.equal(completed.response?.status, "completed")
		assert.match(JSON.stringify(completed.response), /AuthorizationRequired/)
		const recovered = fixture
			.tools()
			.find((tool) => tool.name === approval.app.toolName)
		assert.ok(recovered)
		const Request = Schema.Struct({
			tools: Schema.Array(
				Schema.Struct({
					function: Schema.Struct({
						name: Schema.String,
						strict: Schema.Boolean,
						parameters: Schema.JsonObject,
					}),
				}),
			),
		})
		let requests = 0
		const http = Layer.succeed(
			HttpClient.HttpClient,
			HttpClient.make((request) =>
				Effect.gen(function* () {
					assert.ok(
						request.body._tag === "Uint8Array",
						"Expected a JSON request",
					)
					const body = yield* Schema.decodeEffect(
						Schema.fromJsonString(Request),
					)(new TextDecoder().decode(request.body.body)).pipe(Effect.orDie)
					const fn = body.tools[0]?.function
					assert.ok(fn)
					assert.equal(fn.name, approval.app.toolName)
					requests++
					if (requests === 1)
						assert.equal(
							fn.strict,
							true,
							"Ordinary business tools retain strict mode",
						)
					const invalid =
						fn.parameters["properties"] === undefined ||
						(fn.strict && fn.parameters["additionalProperties"] !== false)
					return HttpClientResponse.fromWeb(
						request,
						new globalThis.Response(
							JSON.stringify(
								invalid
									? {
											error: {
												message: "Invalid strict function schema",
												type: "invalid_request_error",
												code: "invalid_function_parameters",
												param: "tools",
											},
										}
									: {
											id: "recovery-answer",
											model: "fixture-model",
											created: 1,
											choices: [
												{
													index: 0,
													finish_reason: "stop",
													message: {
														role: "assistant",
														content:
															"The operation needs restored account access.",
													},
												},
											],
											usage: {
												prompt_tokens: 1,
												completion_tokens: 1,
												total_tokens: 2,
											},
										},
							),
							{
								status: invalid ? 400 : 200,
								headers: { "content-type": "application/json" },
							},
						),
					)
				}),
			),
		)
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const model = yield* OpenAiCompatProvider.make().model(
						Config.Selection.make({
							provider: Provider.Id.make("openai-compat"),
							model: Model.Id.make("fixture-model"),
						}),
					)
					for (const tool of [original, recovered]) {
						// Reuse the observed declaration without the Turn's handler requirements.
						const declaration = Tool.dynamic(tool.name, {
							parameters: Tool.getJsonSchema(tool),
							success: Schema.Unknown,
						}).annotateMerge(tool.annotations)
						const answer = yield* LanguageModel.generateText({
							prompt: "Explain the operation status",
							toolkit: Toolkit.make(declaration),
							disableToolCallResolution: true,
						}).pipe(Effect.provide(model))
						assert.equal(answer.toolCalls.length, 0)
						assert.equal(
							answer.text,
							"The operation needs restored account access.",
						)
					}
				}).pipe(
					Effect.provide(
						OpenAiCompatProvider.layerClient({
							apiUrl: "https://recovery-model.test/v1",
							apiKey: Redacted.make("fixture-key"),
						}).pipe(Layer.provide(http)),
					),
				),
			),
		)
		assert.equal(requests, 2)
		assert.equal(fixture.publisher.businessCalls(), 0)
		assert.equal(fixture.publisher.writes().length, 0)
	} finally {
		await fixture.close()
	}
})

test("historical App approval cannot be relabeled as the current Turn after a connection change", async () => {
	let sequence = 0
	const fixture = await start({
		write: true,
		callId: () => `write-${++sequence}`,
	})
	try {
		const initial = await fixture.view()
		assert.equal(
			(
				await fixture.post(`/v1/sessions/${fixture.session}/turns`, {
					input: "First write",
					expected: initial.session.revision,
				})
			).status,
			202,
		)
		await fixture.wait()
		const [old] = await fixture.requests()
		assert.ok(old)
		assert.ok(old?.app)
		assert.equal(
			(
				await fixture.post(
					`/v1/sessions/${fixture.session}/turns/${old.turn}/interrupt`,
					{},
				)
			).status,
			200,
		)
		const ended = await fixture.wait()
		const changed = await fetch(
			fixture.host.address + `/v1/connections/${fixture.connected.id}`,
			{
				method: "PUT",
				headers: fixture.headers,
				body: JSON.stringify({
					revision: fixture.connected.revision,
					name: "Changed transfer connection",
					enabled: true,
				}),
			},
		)
		assert.equal(changed.status, 200)
		assert.equal(
			(
				await fixture.post(`/v1/sessions/${fixture.session}/turns`, {
					input: "Current write",
					expected: ended.session.revision,
				})
			).status,
			202,
		)
		await fixture.wait()
		const [current] = await fixture.requests()
		assert.ok(current)
		assert.ok(current?.app)
		assert.notEqual(current.app.toolName, old.app.toolName)
		assert.notEqual(current.turn, old.turn)
		await fixture.omitContextResult(old.toolCallId)
		const held = await fixture.view()
		const approvals = await fixture.requests()
		assert.deepEqual(
			approvals.map((value: { id: string }) => value.id),
			[current.id],
		)
		const staleDecision = await fixture.decide(old, true)
		assert.equal(staleDecision.status, 409, await staleDecision.clone().text())
		assert.equal((await fixture.view()).session.revision, held.session.revision)
		assert.equal(fixture.publisher.writes().length, 0)
		assert.equal((await fixture.decide(current, true)).status, 200)
		const completed = await fixture.wait()
		assert.equal(
			completed.response?.status,
			"completed",
			JSON.stringify(completed.response),
		)
		assert.equal(fixture.publisher.writes().length, 1)
		assert.deepEqual(await fixture.requests(), [])
	} finally {
		await fixture.close()
	}
})

test("a reused model call ID gets a fresh approval in the next Turn without replaying the first write", async () => {
	const fixture = await start({ write: true })
	try {
		let previousApproval: string | undefined
		for (const expectedWrites of [1, 2]) {
			const before = await fixture.view()
			assert.equal(
				(
					await fixture.post(`/v1/sessions/${fixture.session}/turns`, {
						input: "A separately requested write",
						expected: before.session.revision,
					})
				).status,
				202,
			)
			await fixture.wait()
			const approvals = await fixture.requests()
			assert.equal(approvals.length, 1)
			const [current] = approvals
			assert.ok(current)
			assert.notEqual(current.id, previousApproval)
			assert.equal(fixture.publisher.writes().length, expectedWrites - 1)
			assert.equal((await fixture.decide(current, true)).status, 200)
			assert.equal((await fixture.wait()).response?.status, "completed")
			assert.equal(fixture.publisher.writes().length, expectedWrites)
			previousApproval = current.id
		}
	} finally {
		await fixture.close()
	}
})

for (const outcome of [
	"completed",
	"unknown",
	"rejected",
	"second-unknown",
] as const) {
	test(`same Turn App calls have separate approvals and records after ${outcome}`, async () => {
		const fixture = await start({
			write: true,
			sameTurnWrites: 2,
			repeatArguments: outcome === "completed",
		})
		try {
			const before = await fixture.view()
			assert.equal(
				(
					await fixture.post(`/v1/sessions/${fixture.session}/turns`, {
						input: "Perform two separately approved writes",
						expected: before.session.revision,
					})
				).status,
				202,
			)
			await fixture.wait()
			const [first] = await fixture.requests()
			assert.ok(first)
			assert.ok(first?.app)
			if (outcome === "unknown") fixture.publisher.setDropResult(true)
			assert.equal((await fixture.decide(first, true)).status, 200)
			const secondView = await fixture.wait()
			fixture.publisher.setDropResult(false)
			const pending = await fixture.requests()
			assert.equal(pending.length, 1)
			const second = pending[0]
			assert.ok(second)
			assert.ok(second.app)
			assert.equal(second.turn, first.turn)
			assert.equal(second.toolCallId, first.toolCallId)
			assert.notEqual(second.id, first.id)
			assert.notEqual(second.app.id, first.app.id)
			assert.equal(fixture.publisher.writes().length, 1)
			assert.equal((await fixture.decide(first, true)).status, 409)
			assert.equal(
				(await fixture.view()).session.revision,
				secondView.session.revision,
			)
			if (outcome === "second-unknown") fixture.publisher.setDropResult(true)
			assert.equal(
				(await fixture.decide(second, outcome !== "rejected")).status,
				200,
			)
			assert.equal((await fixture.wait()).response?.status, "completed")
			assert.equal(
				fixture.publisher.writes().length,
				outcome === "rejected" ? 1 : 2,
			)
			const records = Schema.decodeUnknownSync(
				Schema.Array(AppExecution.Invocation),
			)(await fixture.get(`/v1/sessions/${fixture.session}/app-operations`))
			assert.equal(records.length, 2)
			assert.equal(
				records.find((r) => r.id === first.app.id)?.status,
				outcome === "unknown" ? "OutcomeUnknown" : "Completed",
			)
			assert.equal(
				records.find((r) => r.id === second.app.id)?.status,
				outcome === "rejected"
					? "Rejected"
					: outcome === "second-unknown"
						? "OutcomeUnknown"
						: "Completed",
			)
			fixture.publisher.setDropResult(false)
			await fixture.restart()
			const saved = Schema.decodeUnknownSync(
				Schema.Array(AppExecution.Invocation),
			)(
				await fixture.get(`/v1/sessions/${fixture.session}/app-operations`),
			).find((record) => record.id === second.app.id)
			assert.ok(saved)
			assert.equal(saved.callOccurrence, 1)
			assert.equal(
				records.find((record) => record.id === first.app.id)?.callOccurrence,
				undefined,
			)
			if (outcome === "second-unknown") {
				const result = await fixture.host.runtime.runPromise(
					Effect.gen(function* () {
						return yield* (yield* Invocations).execute(
							{
								owner: ownerKey(fixture.user.identity),
								session: fixture.session,
								turn: saved.turn,
								callId: saved.callId,
								callOccurrence: saved.callOccurrence ?? 0,
								toolName: saved.toolName,
								source: saved.source,
								arguments: saved.arguments,
							},
							Effect.die("An uncertain occurrence must never be sent again"),
						)
					}),
				)
				assert.equal(result._tag, "Failed")
				assert.equal(result.operationId, second.app.id)
			}
			await fixture.view()
			assert.equal(
				fixture.publisher.writes().length,
				outcome === "rejected" ? 1 : 2,
			)
		} finally {
			await fixture.close()
		}
	})
}

test("request decisions lock the displayed Session and reject a concurrent revision change", async () => {
	const fixture = await start({ write: true })
	const sql = new PgConnection({ connectionString: fixture.host.databaseUrl })
	await sql.connect()
	try {
		const initial = await fixture.view()
		assert.equal(
			(
				await fixture.post(`/v1/sessions/${fixture.session}/turns`, {
					input: "Write after confirmation",
					expected: initial.session.revision,
				})
			).status,
			202,
		)
		const held = await fixture.wait(),
			[request] = await fixture.requests()
		assert.ok(request)
		await sql.query("BEGIN")
		await sql.query(
			"UPDATE openbot_session_references SET revision=revision+1, body=jsonb_set(body::jsonb, '{revision}', to_jsonb(revision+1))::text WHERE namespace=$1 AND id=$2",
			[ownerKey(fixture.user.identity), fixture.session],
		)
		const response = fixture.post(`/v1/requests/${request.id}`, {
			expected: request.revision,
			expectedSessionRevision: held.session.revision,
			decision: "allow",
		})
		let blocked = false
		for (let attempt = 0; attempt < 100; attempt++) {
			await sql.query("SELECT pg_stat_clear_snapshot()")
			const locks = await sql.query(
				"SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT body FROM openbot_session_references%' LIMIT 1",
			)
			if (locks.rows.length > 0) {
				blocked = true
				break
			}
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
		assert.equal(
			blocked,
			true,
			"The decision must wait for the real Session row lock",
		)
		await sql.query("COMMIT")
		assert.equal((await response).status, 409)
		assert.equal(
			(await fixture.get(`/v1/requests/${request.id}`)).status,
			"pending",
		)
		assert.equal(
			(
				await sql.query(
					"SELECT 1 FROM openbot_agent_records WHERE kind='grant'",
				)
			).rowCount,
			0,
		)
		assert.equal(fixture.publisher.writes().length, 0)
		assert.equal((await fixture.decide(request, true)).status, 200)
		assert.equal((await fixture.wait()).response?.status, "completed")
		assert.equal(fixture.publisher.writes().length, 1)
	} finally {
		await sql.query("ROLLBACK")
		await sql.end()
		await fixture.close()
	}
})

for (const readOnly of [true, false]) {
	test(`a session read grant ${readOnly ? "covers only the same read tool" : "never covers a write"}`, async () => {
		const fixture = await start({ readPolicy: readOnly, write: !readOnly })
		try {
			let view = await fixture.view()
			assert.equal(
				(
					await fixture.post(`/v1/sessions/${fixture.session}/turns`, {
						input: "First call",
						expected: view.session.revision,
					})
				).status,
				202,
			)
			const [request] = await fixture.requests()
			assert.ok(request)
			assert.equal((await fixture.decide(request, true, true)).status, 200)
			view = await fixture.wait()
			assert.equal(view.response?.status, "completed")
			const saved = Schema.decodeUnknownSync(
				Schema.Array(AppExecution.Invocation),
			)(await fixture.get(`/v1/sessions/${fixture.session}/app-operations`))[0]
			assert.ok(saved)
			assert.equal(saved.grantReads, readOnly)
			assert.equal(
				(
					await fixture.post(`/v1/sessions/${fixture.session}/turns`, {
						input: "Second call",
						expected: view.session.revision,
					})
				).status,
				202,
			)
			view = await fixture.wait()
			assert.equal(
				Session.status(view.session)._tag,
				readOnly ? "Completed" : "Waiting",
			)
			if (readOnly) {
				assert.deepEqual(await fixture.requests(), [])
				const changed = await fixture.host.runtime.runPromise(
					Effect.flatMap(Invocations, (invocations) =>
						invocations.propose({
							owner: ownerKey(fixture.user.identity),
							session: fixture.session,
							turn: saved.turn,
							callId: "different-tool",
							toolName: "other",
							source: { ...saved.source, name: "write_board" },
							arguments: {},
						}),
					),
				)
				assert.equal(changed.status, "PendingApproval")
				assert.equal(changed.grantReads, false)
			} else assert.equal((await fixture.requests()).length, 1)
		} finally {
			await fixture.close()
		}
	})
}

test("cancel does not overwrite a decision committed while it waited for the request lock", async () => {
	const fixture = await start({ write: true })
	const sql = new PgConnection({ connectionString: fixture.host.databaseUrl })
	await sql.connect()
	try {
		const view = await fixture.view()
		await fixture.post(`/v1/sessions/${fixture.session}/turns`, {
			input: "Pending write",
			expected: view.session.revision,
		})
		const [request] = await fixture.requests()
		assert.ok(request)
		const organizationId = fixture.user.identity.organizationId
		await sql.query("BEGIN")
		await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
			"agents:request:" + organizationId + ":" + request.id,
		])
		await sql.query(
			"UPDATE openbot_agent_records SET status='allowed',body=jsonb_set(body::jsonb,'{request,status}','\"allowed\"'::jsonb)::text WHERE kind='request' AND organization_id=$1 AND id=$2",
			[organizationId, request.id],
		)
		const cancel = fixture.host.runtime.runPromise(
			Effect.flatMap(Requests, (requests) =>
				requests.cancel(organizationId, fixture.session),
			),
		)
		let blocked = false
		for (let attempt = 0; attempt < 100; attempt++) {
			await sql.query("SELECT pg_stat_clear_snapshot()")
			const locks = await sql.query(
				"SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%' LIMIT 1",
			)
			if (locks.rows.length > 0) {
				blocked = true
				break
			}
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
		assert.equal(blocked, true)
		await sql.query("COMMIT")
		await cancel
		assert.equal(
			(await fixture.get(`/v1/requests/${request.id}`)).status,
			"allowed",
		)
	} finally {
		await sql.query("ROLLBACK")
		await sql.end()
		await fixture.close()
	}
})

for (const recovery of ["signal", "restart"] as const)
	test(`an early automated answer is saved once and applied after the exact wait is durable (${recovery})`, async () => {
		const fixture = await start({ write: true })
		const sql = new PgConnection({ connectionString: fixture.host.databaseUrl })
		await sql.connect()
		try {
			const initial = await fixture.view()
			await fixture.post(`/v1/sessions/${fixture.session}/turns`, {
				input: "Confirm one write",
				expected: initial.session.revision,
			})
			const [request] = await fixture.requests()
			assert.ok(request)
			const held = await fixture.view(),
				namespace = ownerKey(fixture.user.identity)
			const pending = {
				...held.session,
				revision: held.session.revision + 1,
				turns: held.session.turns.map((turn) =>
					turn.id === request.turn
						? { ...turn, status: { _tag: "Running" } }
						: turn,
				),
			}
			await sql.query(
				"UPDATE openbot_session_references SET body=$3,revision=$4,status='Running' WHERE namespace=$1 AND id=$2",
				[namespace, fixture.session, JSON.stringify(pending), pending.revision],
			)
			await sql.query(
				"UPDATE openbot_agent_records SET owner=$3,body=jsonb_set(body::jsonb,'{request,approver}',$4::jsonb)::text WHERE kind='request' AND organization_id=$1 AND id=$2",
				[
					fixture.user.identity.organizationId,
					request.id,
					"agent:" + request.agent,
					JSON.stringify({ _tag: "Agent", agent: request.agent }),
				],
			)
			const outcome = await fixture.host.runtime.runPromise(
				Effect.flatMap(Requests, (requests) =>
					requests.decide(fixture.user.identity.organizationId, request.id, {
						by: { _tag: "Agent", agent: request.agent },
						allow: true,
						holds: true,
						scope: "once",
					}),
				),
			)
			assert.equal(outcome._tag, "Deferred")
			assert.equal(outcome.stored.request.status, "pending")
			assert.equal(
				(
					await sql.query(
						"SELECT 1 FROM openbot_agent_records WHERE kind='grant'",
					)
				).rowCount,
				0,
			)
			assert.equal(fixture.publisher.writes().length, 0)
			const waiting = { ...held.session, revision: pending.revision + 1 }
			await sql.query(
				"UPDATE openbot_session_references SET body=$3,revision=$4,status='Waiting' WHERE namespace=$1 AND id=$2",
				[namespace, fixture.session, JSON.stringify(waiting), waiting.revision],
			)
			if (recovery === "restart") await fixture.restart()
			else
				await fixture.host.runtime.runPromise(
					Effect.flatMap(Signals, (signals) =>
						signals.publish(
							Signal.TurnChanged({
								...fixture.user.identity,
								session: fixture.session,
								turn: request.turn,
								status: "Waiting",
							}),
						),
					),
				)
			let completed = await fixture.view()
			for (
				let attempt = 0;
				attempt < 200 && Session.status(completed.session)._tag !== "Completed";
				attempt++
			) {
				await new Promise((resolve) => setTimeout(resolve, 10))
				completed = await fixture.view()
			}
			assert.equal(Session.status(completed.session)._tag, "Completed")
			assert.equal(fixture.publisher.writes().length, 1)
			const stored = await fixture.get(`/v1/requests/${request.id}`)
			assert.equal(stored.status, "allowed")
			assert.equal(
				(
					await sql.query(
						"SELECT 1 FROM openbot_agent_records WHERE kind='grant'",
					)
				).rowCount,
				1,
			)
		} finally {
			await sql.end()
			await fixture.close()
		}
	})

test("native decisions without a displayed revision cannot grant a stopped call", async () => {
	const fixture = await start({ write: true })
	try {
		const initial = await fixture.view()
		await fixture.post(`/v1/sessions/${fixture.session}/turns`, {
			input: "Do not allow after stop",
			expected: initial.session.revision,
		})
		const [request] = await fixture.requests()
		assert.ok(request)
		assert.equal(
			(
				await fixture.post(
					`/v1/sessions/${fixture.session}/turns/${request.turn}/interrupt`,
					{},
				)
			).status,
			200,
		)
		const response = await fixture.post(`/v1/requests/${request.id}`, {
			expected: request.revision,
			decision: "allow",
			scope: "lifetime",
		})
		assert.equal(response.status, 409)
		assert.equal(fixture.publisher.writes().length, 0)
	} finally {
		await fixture.close()
	}
})
