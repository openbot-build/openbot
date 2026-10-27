import { Execution } from "@openbot-build/domain"
import { assert, layer } from "@effect/vitest"
import { ConnectionsApi as Api } from "@openbot-build/api"
import { AppHost } from "@openbot-build/openbot"
import {
	AppConnections,
	AppFixture as Fixture,
	BrowserHost,
	Caller,
} from "@openbot-build/openbot/testing"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import {
	Array as Arr,
	Crypto,
	Effect,
	Layer,
	type Redacted,
	Schedule,
	Schema,
	String as Str,
} from "effect"
import { HttpClientResponse, type HttpMethod } from "effect/http"
import { SqlClient } from "effect/sql"

const publicOrigin = "https://openbot.fixture.test"

/**
 * Calls the API of the host as a signed-in browser. It reads the address for
 * each call, because a restart changes it.
 */
const browser =
	(host: BrowserHost.Host, session: Redacted.Redacted<string>) =>
	(path: string, method: HttpMethod.HttpMethod, payload?: unknown) =>
		Effect.gen(function* () {
			const address = yield* host.address
			const lifecycle =
				Str.startsWith("/v1/connections/")(path) &&
				(method === "PUT" ||
					Str.endsWith("/verify")(path) ||
					Str.endsWith("/revalidate")(path))
			const input = lifecycle
				? {
						...(Schema.is(Schema.JsonObject)(payload) ? payload : {}),
						commandKey: yield* Crypto.Crypto.pipe(
							Effect.flatMap((crypto) => crypto.randomUUIDv4()),
						),
					}
				: payload
			return yield* Caller.withCookie({ address, publicOrigin })(
				session,
				path,
				method,
				input,
			)
		})

const command = Effect.fn("AppLifecycleTest.command")(function* (
	send: ReturnType<typeof browser>,
	path: string,
	method: HttpMethod.HttpMethod,
	payload?: unknown,
) {
	const response = yield* send(path, method, payload)
	assert.equal(response.status, 202, yield* response.text)
	const receipt = yield* HttpClientResponse.schemaBodyJson(Execution.Receipt)(
		response,
	)
	const base = Str.replace(/\/(verify|revalidate|manual)$/, "")(path)
	const result = yield* send(
		`${base}/executions/${receipt.executionId}`,
		"GET",
	).pipe(
		Effect.flatMap(HttpClientResponse.schemaBodyJson(Api.ConnectionExecution)),
		Effect.repeat({
			until: (state) => Execution.isTerminal(state.execution.status),
			schedule: Schedule.spaced("20 millis"),
		}),
		Effect.timeout("30 seconds"),
	)
	assert.equal(result.execution.status, "completed")
	const connection = yield* send(base, "GET").pipe(
		Effect.flatMap(HttpClientResponse.schemaBodyJson(Api.Connection)),
	)
	return { connection, result: result.result }
})
const change = (
	send: ReturnType<typeof browser>,
	path: string,
	method: HttpMethod.HttpMethod,
	payload: unknown,
) =>
	command(send, path, method, payload).pipe(
		Effect.map((value) => value.connection),
	)
const verifyConnection = Effect.fn("AppLifecycleTest.verify")(function* (
	send: ReturnType<typeof browser>,
	path: string,
) {
	const value = yield* command(send, path + "/verify", "POST")
	assert.isNotNull(value.result)
	if (value.result?._tag === "Verified")
		return {
			_tag: "Verified",
			capabilities: {
				...value.result.capabilities,
				connection: value.connection,
			},
		} as const
	assert.equal(value.result?._tag, "Unavailable")
	return { _tag: "Unavailable", connection: value.connection } as const
})

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"live connection management closes old clients, asks for review of changed targets, and resumes cleanup without calling business tools",
		() =>
			Effect.gen(function* () {
				const publisher = yield* Fixture.start()
				const host = yield* BrowserHost.start({
					publicOrigin,
					discovery: publisher.discovery,
					appProbe: publisher.probe,
					appNetwork: Layer.succeed(AppHost.AppNetwork, {
						layer: (owner, origins) =>
							NodeHttpServer.layerUserNetwork({
								owner,
								allowedOrigins: origins,
								ca: publisher.ca,
								allowAddress: (ip) => ip === "127.0.0.1",
							}),
					}),
				})
				const alice = yield* host.login("lifecycle-alice")
				const bob = yield* host.login("lifecycle-bob")
				const send = browser(host, alice.session)
				const sendAsBob = browser(host, bob.session)
				const prepare = Effect.gen(function* () {
					const response = yield* send("/v1/connection-drafts", "POST", {
						input: publisher.origin + "/card",
					})
					assert.strictEqual(response.status, 201)
					return yield* HttpClientResponse.schemaBodyJson(Api.ConnectionDraft)(
						response,
					)
				})
				const draft = yield* prepare
				const values = {
					"header:X-Account": "Work",
					"header:X-Secret": "lifecycle-private-configuration",
				}
				const added = yield* send("/v1/connections", "POST", {
					draftId: draft.id,
					revision: draft.revision,
					cardUrl: publisher.origin + "/card",
					remoteIndex: 0,
					name: "Work documents",
					values,
					confirmed: true,
				})
				assert.strictEqual(added.status, 201)
				const connection = yield* HttpClientResponse.schemaBodyJson(
					Api.Connection,
				)(added)
				const path = "/v1/connections/" + connection.id
				const verified = yield* verifyConnection(send, path)
				assert.strictEqual(verified._tag, "Verified")
				assert.ok(verified._tag === "Verified")
				assert.strictEqual(
					verified.capabilities.connection.availability._tag,
					"Available",
				)
				assert.deepStrictEqual(verified.capabilities.tools, [])
				assert.strictEqual(
					Str.includes(values["header:X-Secret"])(
						yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
							verified,
						),
					),
					false,
				)
				const client = yield* AppConnections.openClient(
					host,
					alice.identity,
					connection.id,
					"Scope test",
				)
				const stopped = yield* change(send, path, "PUT", {
					revision: verified.capabilities.connection.revision,
					name: connection.name,
					enabled: false,
				})
				const before = (yield* publisher.requests).length
				const oldClient = yield* Effect.flip(client.listTools())
				assert.strictEqual(oldClient._tag, "ClientError")
				assert.ok(oldClient._tag === "ClientError")
				assert.strictEqual(oldClient.reason, "Closed")
				assert.strictEqual((yield* publisher.requests).length, before)
				assert.strictEqual(
					(yield* send(path, "PUT", {
						revision: connection.revision,
						name: connection.name,
						enabled: true,
					})).status,
					409,
				)
				const enabled = yield* change(send, path, "PUT", {
					revision: stopped.revision,
					name: connection.name,
					enabled: true,
				})
				assert.strictEqual(enabled.availability._tag, "Unverified")
				yield* publisher.changeCard
				const changed = yield* verifyConnection(send, path)
				assert.strictEqual(changed._tag, "Unavailable")
				assert.ok(changed._tag === "Unavailable")
				assert.strictEqual(
					changed.connection.availability._tag,
					"NeedsRevalidation",
				)
				assert.strictEqual(changed.connection.enabled, false)
				const reviewed = yield* prepare
				const incomplete = yield* send(path + "/revalidate", "POST", {
					revision: changed.connection.revision,
					draftId: reviewed.id,
					remoteIndex: 0,
					values: { "header:X-Account": "Work" },
					confirmed: true,
				})
				assert.strictEqual(incomplete.status, 422, yield* incomplete.text)
				assert.deepStrictEqual(
					(yield* HttpClientResponse.schemaBodyJson(
						Api.ConnectionConfigurationInvalid,
					)(incomplete)).keys,
					["header:X-Secret"],
				)
				const current = yield* change(send, path + "/revalidate", "POST", {
					revision: changed.connection.revision,
					draftId: reviewed.id,
					remoteIndex: 0,
					values,
					confirmed: true,
				})
				assert.strictEqual(current.enabled, true)
				assert.strictEqual(current.endpoint, publisher.origin + "/mcp-updated")
				assert.strictEqual(
					(yield* verifyConnection(send, path))._tag,
					"Verified",
				)
				assert.strictEqual(
					(yield* sendAsBob(path + "/verify", "POST")).status,
					404,
				)
				assert.strictEqual(
					(yield* sendAsBob(path, "DELETE", { commandKey: "other-remove" }))
						.status,
					404,
				)
				yield* host.run(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient
						yield* sql.unsafe("CREATE SEQUENCE app_removal_attempts")
						yield* sql.unsafe(
							"CREATE FUNCTION reject_app_removal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('app_removal_attempts'); RAISE EXCEPTION 'App removal storage unavailable'; END $$",
						)
						yield* sql.unsafe(
							"CREATE TRIGGER reject_app_removal BEFORE DELETE ON openbot_app_connections FOR EACH ROW EXECUTE FUNCTION reject_app_removal()",
						)
					}),
				)
				const pending = yield* send(path, "DELETE", { commandKey: "remove" })
				assert.equal(pending.status, 202, yield* pending.text)
				const receipt = yield* HttpClientResponse.schemaBodyJson(
					Execution.Receipt,
				)(pending)
				yield* host.run(
					Effect.flatMap(
						SqlClient.SqlClient,
						(sql) =>
							sql<{
								is_called: boolean
							}>`SELECT is_called FROM app_removal_attempts`,
					).pipe(
						Effect.repeat({
							until: (rows) => rows[0]?.is_called === true,
							schedule: Schedule.spaced("20 millis"),
						}),
						Effect.timeout("30 seconds"),
					),
				)
				const cleanup = yield* Effect.flatMap(
					send(path, "GET"),
					HttpClientResponse.schemaBodyJson(Api.Connection),
				)
				assert.strictEqual(cleanup.enabled, false)
				assert.strictEqual(
					(yield* send(path, "PUT", {
						revision: cleanup.revision,
						name: cleanup.name,
						enabled: true,
					})).status,
					409,
				)
				yield* host.run(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient
						yield* sql.unsafe(
							"DROP TRIGGER reject_app_removal ON openbot_app_connections",
						)
						yield* sql.unsafe("DROP FUNCTION reject_app_removal()")
					}),
				)
				const replay = yield* send(path, "DELETE", {
					commandKey: "remove",
				}).pipe(
					Effect.flatMap(HttpClientResponse.schemaBodyJson(Execution.Receipt)),
				)
				assert.equal(replay.executionId, receipt.executionId)
				const removed = yield* send(
					`/v1/executions/${receipt.executionId}`,
					"GET",
				).pipe(
					Effect.flatMap(HttpClientResponse.schemaBodyJson(Execution.Record)),
					Effect.repeat({
						until: (state) => Execution.isTerminal(state.status),
						schedule: Schedule.spaced("20 millis"),
					}),
					Effect.timeout("30 seconds"),
				)
				assert.equal(removed.status, "completed")
				assert.strictEqual((yield* send(path, "GET")).status, 404)
				assert.strictEqual(
					Arr.filter(yield* publisher.requests, (request) =>
						Str.includes("tools/call")(request.path),
					).length,
					0,
				)
			}),
	)

	it.effect(
		"manual MCP connections stay private, keep secret headers and use the live lifecycle without Card discovery",
		() =>
			Effect.gen(function* () {
				const publisher = yield* Fixture.start({ capabilities: true })
				const network = (owner: string, origins: ReadonlyArray<string>) =>
					NodeHttpServer.layerUserNetwork({
						owner,
						allowedOrigins: origins,
						ca: publisher.ca,
						allowAddress: (ip) => ip === "127.0.0.1",
					})
				const host = yield* BrowserHost.start({
					publicOrigin,
					appProbe: AppConnections.probeForLoopback(publisher.ca),
					appNetwork: Layer.succeed(AppHost.AppNetwork, { layer: network }),
				})
				const alice = yield* host.login("manual-alice")
				const bob = yield* host.login("manual-bob")
				const send = browser(host, alice.session)
				const crypto = yield* Crypto.Crypto
				const input = {
					id: yield* crypto.randomUUIDv4(),
					name: "Manual documents",
					transport: "streamable-http",
					url: publisher.origin + "/mcp",
					headers: { "X-Account": "Work", "X-Secret": "manual-private-secret" },
				}
				assert.strictEqual(
					(yield* send("/v1/connections/manual", "POST", {
						...input,
						url: "http://example.test/mcp",
					})).status,
					400,
				)
				const created = yield* send("/v1/connections/manual", "POST", input)
				assert.strictEqual(created.status, 201, yield* created.text)
				const connection = yield* HttpClientResponse.schemaBodyJson(
					Api.Connection,
				)(created)
				const path = "/v1/connections/" + connection.id
				assert.strictEqual(connection.sources[0]?.role, "manual")
				assert.strictEqual(
					Str.includes(input.headers["X-Secret"])(yield* created.text),
					false,
				)
				assert.strictEqual(
					(yield* send("/v1/connections/manual", "POST", input)).status,
					201,
				)
				const verified = yield* verifyConnection(send, path)
				assert.strictEqual(verified._tag, "Verified")
				assert.ok(verified._tag === "Verified")
				assert.ok(verified.capabilities.tools.length > 0)
				yield* host.run(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient
						assert.strictEqual(
							(yield* sql`SELECT * FROM openbot_app_index_jobs`).length,
							0,
						)
						const records = yield* sql<{
							readonly body: string
						}>`SELECT body FROM openbot_app_records UNION ALL SELECT body FROM openbot_app_connections`
						assert.strictEqual(
							Arr.some(records, (record) =>
								Str.includes(input.headers["X-Secret"])(record.body),
							),
							false,
						)
					}),
				)
				const client = yield* AppConnections.openClient(
					host,
					alice.identity,
					connection.id,
					"Manual lifecycle",
				)
				const unknownHeader = yield* send(path + "/manual", "PUT", {
					name: "Updated manual documents",
					transport: "streamable-http",
					url: publisher.origin + "/mcp-updated",
					headers: { "X-Account": null, "X-Unknown": null },
					revision: verified.capabilities.connection.revision,
				})
				assert.strictEqual(unknownHeader.status, 422, yield* unknownHeader.text)
				assert.deepStrictEqual(
					(yield* HttpClientResponse.schemaBodyJson(
						Api.ConnectionConfigurationInvalid,
					)(unknownHeader)).keys,
					["header:X-Unknown"],
				)
				const changed = yield* change(send, path + "/manual", "PUT", {
					name: "Updated manual documents",
					transport: "streamable-http",
					url: publisher.origin + "/mcp-updated",
					headers: { "X-Account": null, "X-Secret": null },
					revision: verified.capabilities.connection.revision,
				})
				assert.strictEqual(changed.endpoint, publisher.origin + "/mcp-updated")
				assert.strictEqual(
					Str.includes(input.headers["X-Secret"])(
						yield* Schema.encodeEffect(Schema.fromJsonString(Api.Connection))(
							changed,
						),
					),
					false,
				)
				const before = (yield* publisher.requests).length
				const closed = yield* Effect.flip(client.listTools())
				assert.strictEqual(closed._tag, "ClientError")
				assert.ok(closed._tag === "ClientError")
				assert.strictEqual(closed.reason, "Closed")
				assert.strictEqual((yield* publisher.requests).length, before)
				assert.strictEqual(
					(yield* send(path + "/manual", "PUT", { ...input, revision: 0 }))
						.status,
					409,
				)
				assert.strictEqual(
					(yield* browser(host, bob.session)(path, "GET")).status,
					404,
				)
				yield* host.restart
				// The old caller can release its already closed scope after a server restart.
				yield* client.close
				assert.strictEqual(
					(yield* verifyConnection(send, path))._tag,
					"Verified",
				)
				assert.strictEqual(
					Arr.some(yield* publisher.requests, (request) =>
						Str.startsWith("/card")(request.path),
					),
					false,
				)
				assert.strictEqual(
					Arr.some(yield* publisher.requests, (request) =>
						Str.includes("tools/call")(request.path),
					),
					false,
				)
				const replay = yield* send(path, "DELETE", {
					commandKey: "remove",
				}).pipe(
					Effect.flatMap(HttpClientResponse.schemaBodyJson(Execution.Receipt)),
				)

				const removed = yield* send(
					`/v1/executions/${replay.executionId}`,
					"GET",
				).pipe(
					Effect.flatMap(HttpClientResponse.schemaBodyJson(Execution.Record)),
					Effect.repeat({
						until: (state) => Execution.isTerminal(state.status),
						schedule: Schedule.spaced("20 millis"),
					}),
					Effect.timeout("30 seconds"),
				)
				assert.equal(removed.status, "completed")
				assert.strictEqual((yield* send(path, "GET")).status, 404)
			}),
	)
})
