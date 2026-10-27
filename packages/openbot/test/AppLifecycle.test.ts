import { assert, it, layer } from "@effect/vitest"
import { ConnectionsApi as Api } from "@openbot-build/api"
import { App, Client, Document, Network, Store } from "@openbot-build/protocol"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import {
	Array as Arr,
	Crypto,
	Effect,
	Layer,
	type Redacted,
	Scope,
	String as Str,
} from "effect"
import { HttpClientResponse, type HttpMethod } from "effect/http"
import { SqlClient } from "effect/sql"
import * as Lifecycle from "../src/apps/Lifecycle.ts"
import * as Probe from "../src/apps/Probe.ts"
import { AppHost, AppNetwork } from "../src/apps/AppHost.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"
import * as Caller from "./Caller.ts"
import * as Fixture from "./AppFixture.ts"
import * as BrowserHost from "./BrowserHost.ts"

const publicOrigin = "https://openbot.fixture.test"

/**
 * Calls the API of the host as a signed-in browser. It reads the address for
 * each call, because a restart changes it.
 */
const browser =
	(host: BrowserHost.Host, session: Redacted.Redacted<string>) =>
	(path: string, method: HttpMethod.HttpMethod, payload?: unknown) =>
		Effect.flatMap(host.address, (address) =>
			Caller.withCookie({ address, publicOrigin })(
				session,
				path,
				method,
				payload,
			),
		)

/** Opens an MCP client on a connection of a member. It closes when the test ends. */
const openClient = (
	host: BrowserHost.Host,
	member: { readonly userId: string; readonly organizationId: string },
	connectionId: string,
	name: string,
) =>
	Effect.flatMap(Effect.scope, (scope) =>
		host.run(
			Effect.gen(function* () {
				const app = (yield* AppHost).bind(
					ownerKey(member),
					Client.InvocationPolicy.of({ check: () => Effect.void }),
				)
				return yield* app.open({
					key: { owner: ownerKey(member), connectionId },
					clientInfo: { name, version: "1.0.0" },
				})
			}).pipe(Effect.provideService(Scope.Scope, scope)),
		),
	)

it.effect(
	"App host failures keep their meaning: a removed connection is not found and a bad declaration is invalid",
	() =>
		Effect.gen(function* () {
			const failure = Lifecycle.hostFailure("removed")
			const missing = yield* Effect.flip(
				failure(
					Store.StoreError.make({ reason: "Missing", operation: "Connection" }),
				),
			)
			assert.ok(
				missing._tag === "ExperienceNotFound" && missing.id === "removed",
			)
			const invalid = Api.ConnectionConfigurationInvalid.make({
				keys: ["header:X-Account"],
				message: "Give the account.",
			})
			assert.strictEqual(yield* Effect.flip(failure(invalid)), invalid)
			const document = yield* Effect.flip(
				failure(
					Document.InvalidDocument.make({ kind: "Card", issue: "No name" }),
				),
			)
			assert.strictEqual(document._tag, "ConnectionConfigurationInvalid")
			const pending = yield* Effect.flip(
				failure(
					App.CleanupPending.make({
						key: { owner: "owner", connectionId: "removed" },
						stage: "Credentials",
					}),
				),
			)
			assert.ok(
				pending._tag === "ConnectionCleanupPending" &&
					pending.stage === "Credentials",
			)
			const storage = yield* Effect.flip(
				failure(
					Store.StoreError.make({
						reason: "Unavailable",
						operation: "Connection",
					}),
				),
			)
			assert.strictEqual(storage._tag, "ExperienceStorageUnavailable")
			const network = yield* Effect.flip(
				failure(
					Network.NetworkError.make({
						reason: "Timeout",
						message: "No answer",
					}),
				),
			)
			assert.strictEqual(network._tag, "ExperienceStorageUnavailable")
		}),
)

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
					appNetwork: Layer.succeed(AppNetwork, {
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
				const verify = yield* send(path + "/verify", "POST")
				assert.strictEqual(verify.status, 200, yield* verify.text)
				const verified = yield* HttpClientResponse.schemaBodyJson(
					Api.Verification,
				)(verify)
				assert.strictEqual(verified._tag, "Verified")
				assert.ok(verified._tag === "Verified")
				assert.strictEqual(
					verified.capabilities.connection.availability._tag,
					"Available",
				)
				assert.deepStrictEqual(verified.capabilities.tools, [])
				assert.strictEqual(
					Str.includes(values["header:X-Secret"])(yield* verify.text),
					false,
				)
				const client = yield* openClient(
					host,
					alice.identity,
					connection.id,
					"Scope test",
				)
				const disabled = yield* send(path, "PUT", {
					revision: verified.capabilities.connection.revision,
					name: connection.name,
					enabled: false,
				})
				assert.strictEqual(disabled.status, 200)
				const stopped = yield* HttpClientResponse.schemaBodyJson(
					Api.Connection,
				)(disabled)
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
				const enabled = yield* Effect.flatMap(
					send(path, "PUT", {
						revision: stopped.revision,
						name: connection.name,
						enabled: true,
					}),
					HttpClientResponse.schemaBodyJson(Api.Connection),
				)
				assert.strictEqual(enabled.availability._tag, "Unverified")
				yield* publisher.changeCard
				const changed = yield* Effect.flatMap(
					send(path + "/verify", "POST"),
					HttpClientResponse.schemaBodyJson(Api.Verification),
				)
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
				const revalidation = yield* send(path + "/revalidate", "POST", {
					revision: changed.connection.revision,
					draftId: reviewed.id,
					remoteIndex: 0,
					values,
					confirmed: true,
				})
				assert.strictEqual(revalidation.status, 200, yield* revalidation.text)
				const current = yield* HttpClientResponse.schemaBodyJson(
					Api.Connection,
				)(revalidation)
				assert.strictEqual(current.enabled, true)
				assert.strictEqual(current.endpoint, publisher.origin + "/mcp-updated")
				assert.strictEqual(
					(yield* Effect.flatMap(
						send(path + "/verify", "POST"),
						HttpClientResponse.schemaBodyJson(Api.Verification),
					))._tag,
					"Verified",
				)
				assert.strictEqual(
					(yield* sendAsBob(path + "/verify", "POST")).status,
					404,
				)
				assert.strictEqual((yield* sendAsBob(path, "DELETE")).status, 404)
				yield* host.run(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient
						yield* sql.unsafe(
							"CREATE FUNCTION reject_app_removal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'App removal storage unavailable'; END $$",
						)
						yield* sql.unsafe(
							"CREATE TRIGGER reject_app_removal BEFORE DELETE ON openbot_app_connections FOR EACH ROW EXECUTE FUNCTION reject_app_removal()",
						)
					}),
				)
				const pending = yield* send(path, "DELETE")
				assert.strictEqual(pending.status, 409, yield* pending.text)
				assert.strictEqual(
					(yield* HttpClientResponse.schemaBodyJson(
						Api.ConnectionCleanupPending,
					)(pending)).stage,
					"Connection",
				)
				const cleanup = yield* Effect.flatMap(
					send(path, "GET"),
					HttpClientResponse.schemaBodyJson(Api.Connection),
				)
				assert.strictEqual(cleanup.enabled, false)
				assert.strictEqual(cleanup.availability._tag, "CleanupPending")
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
				assert.strictEqual((yield* send(path, "DELETE")).status, 204)
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
					appProbe: Probe.layerWithNetwork((connection) =>
						network(connection.owner, [new URL(connection.endpoint).origin]),
					),
					appNetwork: Layer.succeed(AppNetwork, { layer: network }),
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
				const verified = yield* Effect.flatMap(
					send(path + "/verify", "POST"),
					HttpClientResponse.schemaBodyJson(Api.Verification),
				)
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
				const client = yield* openClient(
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
				const updated = yield* send(path + "/manual", "PUT", {
					name: "Updated manual documents",
					transport: "streamable-http",
					url: publisher.origin + "/mcp-updated",
					headers: { "X-Account": null, "X-Secret": null },
					revision: verified.capabilities.connection.revision,
				})
				assert.strictEqual(updated.status, 200, yield* updated.text)
				const changed = yield* HttpClientResponse.schemaBodyJson(
					Api.Connection,
				)(updated)
				assert.strictEqual(changed.endpoint, publisher.origin + "/mcp-updated")
				assert.strictEqual(
					Str.includes(input.headers["X-Secret"])(yield* updated.text),
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
				assert.strictEqual(
					(yield* Effect.flatMap(
						send(path + "/verify", "POST"),
						HttpClientResponse.schemaBodyJson(Api.Verification),
					))._tag,
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
				assert.strictEqual((yield* send(path, "DELETE")).status, 204)
				assert.strictEqual((yield* send(path, "GET")).status, 404)
			}),
	)
})
