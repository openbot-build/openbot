import { assert, layer } from "@effect/vitest"
import {
	AppExecution,
	AppExperienceApi,
	ConnectionsApi,
} from "@openbot-build/api"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import {
	Array as Arr,
	Effect,
	Layer,
	Option,
	Ref,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, Response } from "effect/ai"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { AppNetwork } from "../src/apps/AppHost.ts"
import * as Probe from "../src/apps/Probe.ts"
import { serveChecked } from "../../protocol/test/Fixture.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import { message, settled, type Send } from "./Messages.ts"

const publicOrigin = "https://manual.example.com"
const id = "88293612-d35e-4a4b-988c-574ad236912a"
const requestSchema = Schema.fromJsonString(
	Schema.Struct({
		id: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.String])),
		method: Schema.String,
	}),
)

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"A manual legacy service can be added and checked without a publisher card",
		() =>
			Effect.gen(function* () {
				const methods = yield* Ref.make<ReadonlyArray<string>>([])
				const model = yield* LanguageModel.make({
					generateText: () =>
						Effect.succeed([
							Response.makePart("text", { text: '{"changes":[]}' }),
						]),
					streamText: ({ prompt, tools }) => {
						const tool = Arr.findFirst(
							tools,
							(entry) =>
								entry.description !== undefined &&
								Str.includes(" / read_document.")(entry.description),
						)
						const finished = Arr.some(
							prompt.content,
							(entry) => entry.role === "tool",
						)
						const usage = {
							inputTokens: {
								total: 1,
								uncached: 1,
								cacheRead: 0,
								cacheWrite: 0,
							},
							outputTokens: { total: 1, text: 1, reasoning: 0 },
						}
						return finished || Option.isNone(tool)
							? Stream.make(
									Response.makePart("finish", { reason: "stop", usage }),
								)
							: Stream.make(
									Response.makePart("tool-call", {
										id: "legacy-read",
										name: tool.value.name,
										params: {},
										providerExecuted: false,
									}),
									Response.makePart("finish", { reason: "tool-calls", usage }),
								)
					},
				})
				const remote = yield* serveChecked(
					Effect.gen(function* () {
						const http = yield* HttpServerRequest.HttpServerRequest
						if (http.method === "GET")
							return HttpServerResponse.empty({ status: 405 })
						if (http.method === "DELETE")
							return HttpServerResponse.empty({ status: 200 })
						if (http.headers["authorization"] !== "Bearer local-fixture")
							return HttpServerResponse.empty({ status: 401 })
						const request = yield* Schema.decodeEffect(requestSchema)(
							yield* http.text,
						)
						yield* Ref.update(methods, Arr.append(request.method))
						if (request.method === "notifications/initialized")
							return HttpServerResponse.empty({ status: 202 })
						if (request.method === "server/discover")
							return yield* HttpServerResponse.json({
								jsonrpc: "2.0",
								id: request.id,
								error: { code: -32601, message: "Method not found" },
							})
						return yield* HttpServerResponse.json({
							jsonrpc: "2.0",
							id: request.id,
							result:
								request.method === "initialize"
									? {
											protocolVersion: "2025-11-25",
											serverInfo: { name: "legacy-fixture", version: "1.0.0" },
											capabilities: { tools: {} },
										}
									: request.method === "tools/call"
										? {
												content: [{ type: "text", text: "A saved document" }],
												structuredContent: { text: "A saved document" },
											}
										: {
												tools: [
													{
														name: "read_document",
														inputSchema: { type: "object", properties: {} },
													},
												],
											},
						})
					}),
				)
				const network = (owner: string) =>
					NodeHttpServer.layerUserNetwork({
						owner,
						allowedOrigins: [remote.ipOrigin],
						allowAddress: (ip) => ip === "127.0.0.1",
						ca: remote.ca,
					})
				const host = yield* BrowserHost.start({
					publicOrigin,
					model,
					appReadRules: [
						{ cardUrl: "urn:openbot:manual:" + id, tool: "read_document" },
					],
					appProbe: Probe.layerWithNetwork((connection) =>
						network(connection.owner),
					),
					appNetwork: Layer.succeed(AppNetwork, {
						layer: (owner) => network(owner),
					}),
				})
				const call = Caller.withCookie({
					address: yield* host.address,
					publicOrigin,
				})
				const alice = yield* host.login("alice")
				const bob = yield* host.login("bob")
				const created = yield* Caller.read(
					ConnectionsApi.Connection,
					call(alice.session, "/v1/connections/manual", "POST", {
						id,
						name: "Legacy service",
						url: remote.ipOrigin + "/mcp",
						transport: "streamable-http",
						headers: { Authorization: "Bearer local-fixture" },
					}),
					201,
				)
				assert.strictEqual(created.id, id)
				const verified = yield* Caller.read(
					ConnectionsApi.Verification,
					call(alice.session, "/v1/connections/" + id + "/verify", "POST", {}),
					200,
				)
				assert.strictEqual(verified._tag, "Verified")
				if (verified._tag === "Verified") {
					assert.strictEqual(
						verified.capabilities.protocolVersion,
						"2025-11-25",
					)
					assert.strictEqual(verified.capabilities.tools.length, 1)
				}
				assert.strictEqual(
					(yield* call(bob.session, "/v1/connections/" + id)).status,
					404,
				)
				const seen = yield* Ref.get(methods)
				assert.ok(Arr.contains(seen, "initialize"))
				assert.ok(Arr.contains(seen, "tools/list"))
				assert.ok(!Arr.contains(seen, "tools/call"))
				const send: Send = (path, method, payload) =>
					call(alice.session, path, method, payload)
				const bot = yield* host.defaultBot(alice.session)
				const receipt = yield* message(send, bot, "Read a document")
				yield* settled(send, receipt.chat)
				const operations = yield* Caller.read(
					Schema.Array(AppExecution.Invocation),
					call(alice.session, "/v1/chats/" + receipt.chat + "/app-operations"),
					200,
				)
				assert.strictEqual(operations.length, 1)
				assert.strictEqual(
					operations[0]?.source.cardUrl,
					"urn:openbot:manual:" + id,
				)
				assert.strictEqual(operations[0]?.status, "Completed")
				assert.strictEqual(
					Arr.filter(
						yield* Ref.get(methods),
						(method) => method === "tools/call",
					).length,
					1,
				)
				const beforeImport = yield* Ref.get(methods)
				const exported = yield* Caller.read(
					AppExperienceApi.Transfer,
					call(alice.session, "/v1/app-experience/export"),
					200,
				)
				assert.strictEqual(exported.apps.length, 1)
				assert.deepStrictEqual(exported.apps[0]?.manual, {
					url: remote.ipOrigin + "/mcp",
					transport: "streamable-http",
					headers: ["Authorization"],
				})
				assert.ok(
					!Str.includes("local-fixture")(
						yield* Schema.encodeEffect(
							Schema.fromJsonString(AppExperienceApi.Transfer),
						)(exported),
					),
				)
				const imported = yield* Caller.read(
					AppExperienceApi.Imported,
					call(alice.session, "/v1/app-experience/import", "POST", exported),
					200,
				)
				const draft = imported.entries[0]?.draft
				assert.ok(draft !== null && draft !== undefined)
				assert.ok(draft.manual !== undefined)
				assert.deepStrictEqual(yield* Ref.get(methods), beforeImport)
				assert.strictEqual(
					(yield* call(bob.session, "/v1/connection-drafts/" + draft.id))
						.status,
					404,
				)
				const confirm = {
					draftId: draft.id,
					revision: draft.revision,
					cardUrl: "urn:openbot:manual:" + draft.id,
					remoteIndex: 0,
					name: "Restored legacy service",
					values: {},
					confirmed: true,
				}
				assert.strictEqual(
					(yield* call(alice.session, "/v1/connections", "POST", confirm))
						.status,
					422,
				)
				assert.deepStrictEqual(yield* Ref.get(methods), beforeImport)
				const restored = yield* Caller.read(
					ConnectionsApi.Connection,
					call(alice.session, "/v1/connections", "POST", {
						...confirm,
						values: { "header:Authorization": "Bearer local-fixture" },
					}),
					201,
				)
				assert.notStrictEqual(restored.id, id)
				assert.strictEqual(restored.id, draft.id)
				assert.strictEqual(restored.name, confirm.name)
				assert.ok(
					!Str.includes("local-fixture")(
						yield* Schema.encodeEffect(
							Schema.fromJsonString(ConnectionsApi.Connection),
						)(restored),
					),
				)
				const again = yield* Caller.read(
					ConnectionsApi.Connection,
					call(alice.session, "/v1/connections", "POST", confirm),
					201,
				)
				assert.strictEqual(again.id, restored.id)
				const restoredCheck = yield* Caller.read(
					ConnectionsApi.Verification,
					call(
						alice.session,
						"/v1/connections/" + restored.id + "/verify",
						"POST",
						{},
					),
					200,
				)
				assert.strictEqual(restoredCheck._tag, "Verified")
			}),
	)
})
