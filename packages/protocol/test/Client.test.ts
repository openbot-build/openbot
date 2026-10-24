// Tests are entry points, so they provide their own Layers.
// @effect-diagnostics strictEffectProvide:off
import {
	Array as EffectArray,
	Effect,
	Fiber,
	Layer,
	Redacted,
	Schema,
	Stream,
	Match,
} from "effect"
import {
	CatalogDiscovery,
	MemoryStore,
	AppConnections,
	McpClient,
	Client,
	Document,
	Store,
} from "@openbot-build/protocol"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { assert, it } from "@effect/vitest"
import { type IncomingHttpHeaders, type ServerResponse } from "node:http"
import * as Mcp from "@modelcontextprotocol/client"

import { startHttps } from "./Fixture.ts"

// These tests build their Layers at the edge of the test runtime.

const WireRequest = Schema.Struct({
	id: Schema.optional(Schema.Union([Schema.Finite, Schema.String])),
	method: Schema.String,
	params: Schema.optional(Schema.JsonObject),
})
const paramsOf = Schema.decodeUnknownSync(
	Schema.Struct({
		name: Schema.optional(Schema.String),
		cursor: Schema.optional(Schema.String),
		uri: Schema.optional(Schema.String),
		arguments: Schema.optional(Schema.JsonObject),
		_meta: Schema.optional(Schema.JsonObject),
		requestState: Schema.optional(Schema.String),
		inputResponses: Schema.optional(Schema.JsonObject),
		notifications: Schema.optional(Schema.JsonObject),
	}),
)

/** A separate HTTP implementation of the chosen wire contract. */
const service = async () => {
	let requests: ReadonlyArray<{
		request: typeof WireRequest.Type
		headers: IncomingHttpHeaders
		url: string
		method: string
	}> = []
	const state = {
		writes: 0,
		listReads: 0,
		inputId: "consent",
		versions: [Document.protocolVersion],
		toolsOnly: false,
		revision: 1,
		aborted: 0,
	}
	let subscription: ServerResponse | undefined
	const info = { name: "independent-service", version: "1.0.0" }
	const meta = { [Mcp.SERVER_INFO_META_KEY]: info }
	const tools = [
		{
			name: "Write",
			inputSchema: {
				type: "object",
				properties: {
					text: { type: "string", minLength: 1 },
				},
				required: ["text"],
				additionalProperties: false,
			},
			outputSchema: {
				type: "object",
				properties: { id: { type: "integer" } },
				required: ["id"],
			},
		},
		{
			name: "Mapped",
			inputSchema: {
				type: "object",
				properties: {
					locale: {
						type: "string",
						"x-mcp-header": "Locale",
					},
				},
				required: ["locale"],
			},
		},
		{
			name: "AppOnly",
			inputSchema: { type: "object" },
			_meta: { ui: { visibility: ["app"] } },
		},
		...["NeedInput", "BadOutput", "Fail", "Stream", "Hang", "Drop"].map(
			(name) => ({
				name,
				inputSchema: { type: "object" },
				outputSchema: {
					type: "object",
					properties: { id: { type: "integer" } },
					required: ["id"],
				},
			}),
		),
	]
	const fixture = await startHttps((req, res) => {
		let body = ""
		req.setEncoding("utf8")
		req.on("data", (part: string) => {
			body += part
		})
		req.on("end", () => {
			const request = Schema.decodeSync(Schema.fromJsonString(WireRequest))(
				body,
			)
			requests = EffectArray.append(requests, {
				request,
				headers: req.headers,
				url: req.url ?? "",
				method: req.method ?? "",
			})
			const params = paramsOf(request.params ?? {})
			const message = (value: object) => ({
				jsonrpc: "2.0",
				id: request.id,
				result: {
					resultType: "complete",
					...([
						"tools/list",
						"resources/list",
						"resources/templates/list",
						"resources/read",
						"prompts/list",
					].includes(request.method)
						? {
								ttlMs: 60000,
								cacheScope: "private",
							}
						: {}),
					...value,
					_meta: meta,
				},
			})
			const reply = (value: object) => {
				res.writeHead(200, {
					"content-type": "application/json",
				})
				res.end(JSON.stringify(message(value)))
			}
			Match.value(request.method).pipe(
				Match.when("server/discover", () => {
					reply({
						supportedVersions: state.versions,
						capabilities: state.toolsOnly
							? { tools: {} }
							: {
									tools: {
										listChanged: true,
									},
									resources: {
										listChanged: true,
									},
									prompts: {},
								},
					})
					return
				}),
				Match.when("tools/list", () => {
					{
						state.listReads++
						const listed = tools.map((tool) => ({
							...tool,
							description: `revision ${state.revision}`,
						}))
						reply(
							params.cursor === undefined
								? {
										tools: listed.slice(0, 2),
										nextCursor: "next",
									}
								: {
										tools: listed.slice(2),
									},
						)
						return
					}
				}),
				Match.when("resources/list", () => {
					reply({
						resources: [
							{
								uri: "notes://latest",
								name: "Latest",
							},
						],
					})
					return
				}),
				Match.when("resources/templates/list", () => {
					reply({
						resourceTemplates: [
							{
								uriTemplate: "notes://{id}",
								name: "Note",
							},
						],
					})
					return
				}),
				Match.when("resources/read", () => {
					reply({
						contents: [
							{
								uri: params.uri,
								text: "resource text",
								mimeType: "text/plain",
								_meta: {
									origin: "independent",
								},
							},
						],
					})
					return
				}),
				Match.when("prompts/list", () => {
					reply({
						prompts: [{ name: "Summary" }],
					})
					return
				}),
				Match.when("prompts/get", () => {
					reply({
						messages: [
							{
								role: "user",
								content: {
									type: "text" as const,
									text: "Summarize actual notes",
								},
							},
						],
					})
					return
				}),
				Match.when("tools/call", () => {
					{
						if (
							params.name === "NeedInput" &&
							params.inputResponses === undefined
						) {
							res.writeHead(200, {
								"content-type": "application/json",
							})
							res.end(
								JSON.stringify({
									jsonrpc: "2.0",
									id: request.id,
									result: {
										resultType: "input_required",
										inputRequests: {
											[state.inputId]: {
												method: "elicitation/create",
												params: {
													message: "Create a note?",
													requestedSchema: {
														type: "object" as const,
														properties: {
															text: {
																type: "string" as const,
															},
														},
													},
												},
											},
										},
										requestState: "server-owned-operation-1",
										_meta: meta,
									},
								}),
							)
							return
						}
						if (params.name === "NeedInput") {
							assert.strictEqual(
								params.requestState,
								"server-owned-operation-1",
							)
							assert.deepStrictEqual(params.inputResponses, {
								consent: {
									action: "accept",
									content: {
										text: "yes",
									},
								},
							})
						}
						if (params.name === "Hang") {
							res.writeHead(200, {
								"content-type": "text/event-stream",
							})
							res.write(": alive\n\n")
							res.on("close", () => state.aborted++)
							return
						}
						if (params.name === "Stream") {
							res.writeHead(200, {
								"content-type": "text/event-stream",
							})
							res.write(": keepalive\n\n")
							res.write(
								`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: params._meta?.["progressToken"], progress: 1, total: 1 } })}\n\n`,
							)
							res.write(
								`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working", _meta: meta } })}\n\n`,
							)
							res.end(
								`data: ${JSON.stringify(message({ content: [{ type: "text" as const, text: "stream done" }], structuredContent: { id: 9 } }))}\n\n`,
							)
							return
						}
						if (params.name === "Drop") {
							state.writes++
							req.socket.destroy()
							return
						}
						if (params.name === "Fail") {
							reply({
								isError: true,
								content: [
									{
										type: "text" as const,
										text: "business rejected",
									},
								],
							})
							return
						}
						if (params.name === "BadOutput") {
							reply({
								content: [
									{
										type: "text" as const,
										text: "wrong",
									},
								],
								structuredContent: {
									id: "wrong type",
								},
							})
							return
						}
						if (params.name === "Write" || params.name === "NeedInput")
							state.writes++
						reply({
							content: [
								{
									type: "text" as const,
									text: String(params.arguments?.["text"] ?? "done"),
								},
							],
							structuredContent: {
								id: state.writes,
							},
							_meta: { retained: true },
						})
						return
					}
				}),
				Match.when("subscriptions/listen", () => {
					{
						subscription = res
						res.writeHead(200, {
							"content-type": "text/event-stream",
						})
						res.write(
							`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { notifications: params.notifications, _meta: { [Mcp.SUBSCRIPTION_ID_META_KEY]: request.id, ...meta } } })}\n\n`,
						)
						res.on("close", () => {
							subscription = undefined
							state.aborted++
						})
						return
					}
				}),
				Match.orElse(() => {
					res.writeHead(400)
					res.end()
				}),
			)
		})
	})
	const key = { owner: "alice", connectionId: "notes" }
	const endpoint = fixture.ipOrigin + "/mcp?account=1"
	const cardUrl = fixture.ipOrigin + "/card"
	const record: Store.AppRecord = {
		cardUrl,
		card: {
			$schema: Document.cardSchemaUrl,
			name: "example.test/notes",
			version: "1.0.0",
			description: "Notes",
			remotes: [
				{
					type: "streamable-http",
					url: endpoint,
					supportedProtocolVersions: [Document.protocolVersion],
				},
			],
		},
		sources: [],
	}
	const connection: Store.UserConnection = {
		...key,
		cardUrl,
		endpoint,
		remoteIndex: 0,
		configuration: Redacted.make({}),
		headers: Redacted.make({}),
		state: "Enabled",
		authorization: { _tag: "Unprotected" },
	}
	let denied = false
	const layers = Layer.mergeAll(
		NodeHttpServer.layerUserNetwork({
			owner: "alice",
			allowedOrigins: [fixture.ipOrigin],
			allowAddress: (ip) => ip === "127.0.0.1",
			ca: fixture.ca,
		}),
		MemoryStore.layer,
		MemoryStore.layerCredentials,
		AppConnections.layerConnectionScopes,
		McpClient.layerPolicy((invocation) =>
			denied && invocation.action === "tools/call"
				? Effect.fail(
						new Client.PermissionDenied({
							action: invocation.action,
							target: invocation.target,
						}),
					)
				: Effect.void,
		),
	)
	const prepare = Effect.gen(function* () {
		const store = yield* Store.AppStore
		yield* store.save({ app: record, connection })
	})
	const connect = (inputs?: Client.InputHandler) =>
		McpClient.open({
			key,
			clientInfo: { name: "protocol-test-host", version: "1.0.0" },
			...(inputs === undefined ? {} : { inputs }),
		})
	return {
		...fixture,
		key,
		endpoint,
		record,
		connection,
		get requests() {
			return requests
		},
		set requests(value: typeof requests) {
			requests = value
		},
		state,
		layers,
		prepare,
		connect,
		deny: () => {
			denied = true
		},
		change: () => {
			state.revision++
			const id = requests.findLast(
				(r) => r.request.method === "subscriptions/listen",
			)?.request.id
			subscription?.write(
				`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { _meta: { [Mcp.SUBSCRIPTION_ID_META_KEY]: id, ...meta } } })}\n\n`,
			)
		},
	}
}

// Each test starts its own service and closes it when the test ends.
const openService = Effect.acquireRelease(
	Effect.promise(() => service()),
	(fixture) => Effect.promise(() => fixture.close()),
)
// A fresh Layer for each provide, like a fresh runtime.
const layersOf = (fixture: Effect.Success<typeof openService>) =>
	fixture.layers.pipe(Layer.provideMerge([CatalogDiscovery.layerRules]))

it.live(
	"the protocol client uses live discovery, standard pages, schemas, headers and one shared policy",
	() =>
		Effect.gen(function* () {
			const fixture = yield* openService
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* fixture.prepare
					const client = yield* fixture.connect()
					assert.strictEqual(
						client.discovery.supportedVersions.includes(
							Document.protocolVersion,
						),
						true,
					)
					assert.strictEqual(
						fixture.requests[0]?.request.method,
						"server/discover",
					)
					assert.strictEqual((yield* client.listTools()).tools.length, 9)
					assert.strictEqual(
						(yield* client.modelTools).some((tool) => tool.name === "AppOnly"),
						false,
					)
					const created = yield* client.callTool(
						{
							name: "Write",
							arguments: {
								text: "real MCP result",
							},
						},
						{ source: "model" },
					)
					assert.strictEqual(created._tag, "Completed")
					Match.value(created).pipe(
						Match.tag("Completed", (created) => {
							assert.deepStrictEqual(created.result.structuredContent, {
								id: 1,
							})
						}),
						Match.orElse(() => undefined),
					)
					const before = fixture.requests.length
					const invalid = yield* Effect.result(
						client.callTool(
							{
								name: "Write",
								arguments: {
									text: "",
								},
							},
							{ source: "model" },
						),
					)
					assert.strictEqual(invalid._tag, "Failure")
					assert.ok(
						fixture.requests
							.slice(before)
							.every((r) => r.request.method !== "tools/call"),
					)
					const malformed = yield* Effect.result(
						client.callTool(
							{ name: "BadOutput" },
							{ source: "host", readOnly: true },
						),
					)
					assert.strictEqual(malformed._tag, "Failure")
					Match.value(malformed).pipe(
						Match.tag("Failure", (malformed) => {
							assert.strictEqual(malformed.failure._tag, "ClientError")
						}),
						Match.orElse(() => undefined),
					)
					const failed = yield* Effect.result(
						client.callTool({ name: "Fail" }, { source: "host" }),
					)
					assert.strictEqual(failed._tag, "Failure")
					Match.value(failed).pipe(
						Match.when(
							{
								_tag: "Failure",
								failure: Match.instanceOf(Client.ToolFailure),
							},
							({ failure }) => {
								assert.strictEqual(failure.result.content[0]?.type, "text")
							},
						),
						Match.orElse(() => undefined),
					)
					yield* client.callTool(
						{
							name: "Mapped",
							arguments: {
								locale: "\uFF2F\uFF2B",
							},
						},
						{ source: "host" },
					)
					assert.strictEqual(
						fixture.requests.findLast((r) => r.request.method === "tools/call")
							?.headers["mcp-param-locale"],
						"=?base64?77yv77yr?=",
					)
					const resource = yield* client.readTemplate({
						template: "notes://{id}",
						values: { id: "42" },
						source: "model",
					})
					Match.value(resource).pipe(
						Match.tag("Completed", (resource) => {
							assert.strictEqual(resource.result.contents[0]?.uri, "notes://42")
						}),
						Match.orElse(() => undefined),
					)
					const prompt = yield* client.getPrompt(
						{ name: "Summary" },
						{ source: "model" },
					)
					Match.value(prompt).pipe(
						Match.tag("Completed", (prompt) => {
							assert.strictEqual(
								prompt.result.messages[0]?.content.type,
								"text",
							)
						}),
						Match.orElse(() => undefined),
					)
					fixture.deny()
					const deniedCount = fixture.requests.length
					for (const source of ["model", "app"] as const)
						assert.strictEqual(
							(yield* Effect.result(
								client.callTool(
									{
										name: "Write",
										arguments: {
											text: "denied",
										},
									},
									{
										source,
									},
								),
							))._tag,
							"Failure",
						)
					assert.strictEqual(fixture.requests.length, deniedCount)
					assert.strictEqual(fixture.state.writes, 1)
					assert.ok(
						fixture.requests.every(
							(r) =>
								r.method === "POST" &&
								r.url === "/mcp?account=1" &&
								r.headers["mcp-session-id"] === undefined,
						),
					)
					assert.ok(
						fixture.requests.every((r) => r.request.method !== "initialize"),
					)
					assert.strictEqual(
						fixture.requests.find((r) => r.request.method === "tools/call")
							?.headers["mcp-protocol-version"],
						Document.protocolVersion,
					)
				}),
			).pipe(Effect.provide(layersOf(fixture)))
		}),
)

it.live(
	"MRTR stays pending until a capable host explicitly resumes the same operation",
	() =>
		Effect.gen(function* () {
			const fixture = yield* openService
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* fixture.prepare
					const noInputs = yield* fixture.connect()
					const pending = yield* noInputs.callTool(
						{ name: "NeedInput" },
						{ source: "host" },
					)
					assert.strictEqual(pending._tag, "InputRequired")
					return yield* Match.value(pending).pipe(
						Match.tag("InputRequired", (pending) =>
							Effect.gen(function* () {
								assert.strictEqual(fixture.state.writes, 0)
								assert.strictEqual(
									(yield* Effect.result(pending.handle))._tag,
									"Failure",
								)
								assert.strictEqual(fixture.state.writes, 0)
								const client = yield* fixture.connect({
									capabilities: {
										elicitation: {
											form: {},
										},
									},
									handle: () =>
										Effect.succeed({
											action: "accept",
											content: {
												text: "yes",
											},
										}),
								})
								const operation = yield* client.callTool(
									{ name: "NeedInput" },
									{ source: "host" },
								)
								assert.strictEqual(operation._tag, "InputRequired")
								return yield* Match.value(operation).pipe(
									Match.tag("InputRequired", (operation) =>
										Effect.gen(function* () {
											const completed = yield* operation.handle
											assert.strictEqual(completed._tag, "Completed")
											assert.strictEqual(fixture.state.writes, 1)
											const requests = fixture.requests.filter(
												(r) => r.request.method === "tools/call",
											)
											assert.strictEqual(requests.length, 3)
											assert.strictEqual(
												requests[2]?.request.params?.["requestState"],
												"server-owned-operation-1",
											)
										}),
									),
									Match.orElse(() => Effect.void),
								)
							}),
						),
						Match.orElse(() => Effect.void),
					)
				}),
			).pipe(Effect.provide(layersOf(fixture)))
		}),
)

it.live(
	"SSE progress, explicit subscriptions, cancellation and unknown write outcomes stay distinct",
	() =>
		Effect.gen(function* () {
			const fixture = yield* openService
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* fixture.prepare
					const client = yield* fixture.connect()
					let progress: ReadonlyArray<number> = []
					const result = yield* client.callTool(
						{ name: "Stream" },
						{
							source: "host",
							onprogress: (event) =>
								(progress = EffectArray.append(progress, event.progress)),
						},
					)
					assert.strictEqual(result._tag, "Completed")
					assert.deepStrictEqual(progress, [1])
					const received = yield* Effect.forkChild(
						client.notifications.pipe(
							Stream.filter(
								(n) => n.method === "notifications/tools/list_changed",
							),
							Stream.take(1),
							Stream.runCollect,
						),
					)
					const subscription = yield* client.listen({
						toolsListChanged: true,
					})
					assert.strictEqual(subscription.honoredFilter.toolsListChanged, true)
					fixture.change()
					yield* Fiber.join(received)
					assert.strictEqual(
						(yield* client.listTools()).tools[0]?.description,
						"revision 2",
					)
					yield* subscription.close
					assert.strictEqual(yield* subscription.closed, "local")
					const hanging = yield* Effect.forkChild(
						client.callTool({ name: "Hang" }, { source: "host" }),
					)
					const waitForRequest: Effect.Effect<void> = Effect.suspend(() =>
						fixture.requests.some(
							(r) => paramsOf(r.request.params ?? {}).name === "Hang",
						)
							? Effect.void
							: Effect.yieldNow.pipe(Effect.andThen(() => waitForRequest)),
					)
					yield* waitForRequest
					yield* Fiber.interrupt(hanging)
					const unknown = yield* Effect.result(
						client.callTool(
							{ name: "Drop" },
							{
								source: "host",
								timeoutMs: 500,
							},
						),
					)
					assert.strictEqual(unknown._tag, "Failure")
					Match.value(unknown).pipe(
						Match.tag("Failure", (unknown) => {
							assert.strictEqual(unknown.failure._tag, "OutcomeUnknown")
						}),
						Match.orElse(() => undefined),
					)
					assert.strictEqual(fixture.state.writes, 1)
					assert.strictEqual(
						fixture.requests.filter(
							(r) => paramsOf(r.request.params ?? {}).name === "Drop",
						).length,
						1,
					)
					assert.ok(
						fixture.requests.every(
							(r) => r.request.method !== "notifications/cancelled",
						),
					)
				}),
			).pipe(Effect.provide(layersOf(fixture)))
			assert.ok(fixture.state.aborted >= 2)
		}),
)

it.live(
	"Version mismatch fails before tools, and a service that advertises only tools gets no other lists",
	() =>
		Effect.gen(function* () {
			const fixture = yield* openService
			fixture.state.versions = ["2025-11-25"]
			const error = yield* Effect.flip(
				Effect.scoped(
					Effect.gen(function* () {
						yield* fixture.prepare
						return yield* fixture.connect()
					}),
				).pipe(Effect.provide(layersOf(fixture))),
			)
			assert.match(String(error), /ClientError/)
			assert.ok(
				fixture.requests.every((r) => r.request.method === "server/discover"),
			)
			fixture.requests = []
			fixture.state.versions = [Document.protocolVersion]
			fixture.state.toolsOnly = true
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* fixture.prepare
					yield* fixture.connect()
				}),
			).pipe(Effect.provide(layersOf(fixture)))
			assert.ok(
				fixture.requests.every((r) =>
					["server/discover", "tools/list"].includes(r.request.method),
				),
			)
		}),
)

it.live(
	"input response identifiers cannot collide with a joined identifier",
	() =>
		Effect.gen(function* () {
			const fixture = yield* openService
			fixture.state.inputId = "a\0b"
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* fixture.prepare
					const client = yield* fixture.connect({
						capabilities: { elicitation: { form: {} } },
						handle: () =>
							Effect.succeed({ action: "accept", content: { text: "yes" } }),
					})
					const operation = yield* client.callTool(
						{ name: "NeedInput" },
						{ source: "host" },
					)
					assert.ok(operation._tag === "InputRequired")
					const before = fixture.requests.length
					const response = {
						action: "accept" as const,
						content: { text: "yes" },
					}
					const result = yield* Effect.result(
						operation.respond({ a: response, b: response }),
					)
					assert.ok(result._tag === "Failure")
					assert.ok(result.failure._tag === "ClientError")
					assert.strictEqual(result.failure.reason, "Schema")
					assert.strictEqual(fixture.requests.length, before)
					assert.strictEqual(fixture.state.writes, 0)
				}),
			).pipe(Effect.provide(layersOf(fixture)))
		}),
)
