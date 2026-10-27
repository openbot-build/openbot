import {
	Array as Arr,
	Cause,
	Effect,
	Fiber,
	Layer,
	Option,
	pipe,
	Queue,
	Redacted,
	Schema,
	Stream,
	Match,
} from "effect"
import { Headers, HttpServerRequest, HttpServerResponse } from "effect/http"
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
import { NodeHttpServerRequest, NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import * as Mcp from "@modelcontextprotocol/client"

import { Fixture } from "@openbot-build/protocol/testing"

// These tests build their Layers at the edge of the test runtime.

const WireRequest = Schema.Struct({
	id: Schema.optional(Schema.Union([Schema.Finite, Schema.String])),
	method: Schema.String,
	params: Schema.optional(Schema.JsonObject),
})
const Params = Schema.Struct({
	name: Schema.optional(Schema.String),
	cursor: Schema.optional(Schema.String),
	uri: Schema.optional(Schema.String),
	arguments: Schema.optional(Schema.JsonObject),
	_meta: Schema.optional(Schema.JsonObject),
	requestState: Schema.optional(Schema.String),
	inputResponses: Schema.optional(Schema.JsonObject),
	notifications: Schema.optional(Schema.JsonObject),
})
const decodeRequest = Schema.decodeEffect(Schema.fromJsonString(WireRequest))
const decodeParams = Schema.decodeUnknownEffect(Params)
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

/** Gives one server-sent event with a JSON value as its data. */
const event = (value: unknown) =>
	Effect.map(encodeJson(value), (json) => `data: ${json}\n\n`)

/** A request that the service got. */
interface Received {
	readonly request: typeof WireRequest.Type
	readonly params: typeof Params.Type
	readonly headers: Headers.Headers
	readonly url: string
	readonly method: string
}

/**
 * A separate HTTP implementation of the chosen wire contract. It stops when
 * the scope closes.
 */
const service = Effect.gen(function* () {
	let requests: ReadonlyArray<Received> = []
	const state = {
		writes: 0,
		listReads: 0,
		inputId: "consent",
		versions: [Document.protocolVersion],
		toolsOnly: false,
		protocolError: false,
		/** When it is true, every tools/list page names a new next page. */
		endlessPages: false,
		revision: 1,
		aborted: 0,
	}
	/** The open event stream of the subscription, if there is one. */
	let subscription: Queue.Queue<string> | undefined
	/** Gets a value when a call of the Hang tool runs and its response is open. */
	const hanging = yield* Queue.unbounded<void>()
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
		...Arr.map(
			["NeedInput", "BadOutput", "Fail", "Stream", "Hang", "Drop"],
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
	/** An event stream that sends the text parts and closes. */
	const events = (...parts: ReadonlyArray<string>) =>
		HttpServerResponse.stream(Stream.encodeText(Stream.fromIterable(parts)), {
			contentType: "text/event-stream",
		})
	const fixture = yield* Fixture.serveChecked(
		Effect.gen(function* () {
			const http = yield* HttpServerRequest.HttpServerRequest
			const request = yield* Effect.flatMap(http.text, decodeRequest)
			const params = yield* decodeParams(request.params ?? {})
			requests = Arr.append(requests, {
				request,
				params,
				headers: http.headers,
				url: http.url,
				method: http.method,
			})
			const message = (value: object) => ({
				jsonrpc: "2.0",
				id: request.id,
				result: {
					resultType: "complete",
					...(Arr.contains(
						[
							"tools/list",
							"resources/list",
							"resources/templates/list",
							"resources/read",
							"prompts/list",
						],
						request.method,
					)
						? {
								ttlMs: 60000,
								cacheScope: "private",
							}
						: {}),
					...value,
					_meta: meta,
				},
			})
			const reply = (value: object) => HttpServerResponse.json(message(value))
			const callTool = Effect.gen(function* () {
				if (params.name === "NeedInput" && params.inputResponses === undefined)
					return yield* HttpServerResponse.json({
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
					})
				if (params.name === "NeedInput") {
					assert.strictEqual(params.requestState, "server-owned-operation-1")
					assert.deepStrictEqual(params.inputResponses, {
						consent: {
							action: "accept",
							content: {
								text: "yes",
							},
						},
					})
				}
				if (params.name === "Hang")
					return HttpServerResponse.stream(
						Stream.make(": alive\n\n").pipe(
							Stream.encodeText,
							Stream.concat(
								Stream.fromEffectDrain(Queue.offer(hanging, undefined)),
							),
							Stream.concat(Stream.never),
							Stream.ensuring(
								Effect.sync(() => {
									state.aborted++
								}),
							),
						),
						{ contentType: "text/event-stream" },
					)
				if (params.name === "Stream")
					return events(
						": keepalive\n\n",
						yield* event({
							jsonrpc: "2.0",
							method: "notifications/progress",
							params: {
								progressToken: params._meta?.["progressToken"],
								progress: 1,
								total: 1,
							},
						}),
						yield* event({
							jsonrpc: "2.0",
							method: "notifications/message",
							params: { level: "info", data: "working", _meta: meta },
						}),
						yield* event(
							message({
								content: [{ type: "text" as const, text: "stream done" }],
								structuredContent: { id: 9 },
							}),
						),
					)
				if (params.name === "Drop") {
					state.writes++
					// Effect has no way to drop a connection without an answer, so the
					// test uses the Node socket. The request fiber stops when the socket
					// closes.
					NodeHttpServerRequest.toIncomingMessage(http).socket.destroy()
					return yield* Effect.never
				}
				if (params.name === "Fail")
					return yield* reply({
						isError: true,
						content: [
							{
								type: "text" as const,
								text: "business rejected",
							},
						],
					})
				if (params.name === "BadOutput" && state.protocolError)
					return yield* HttpServerResponse.json({
						jsonrpc: "2.0",
						id: request.id,
						error: { code: -32603, message: "private-remote-detail" },
					})
				if (params.name === "BadOutput")
					return yield* reply({
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
				if (params.name === "Write" || params.name === "NeedInput")
					state.writes++
				return yield* reply({
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
			})
			const listen = Effect.gen(function* () {
				const queue = yield* Queue.unbounded<string>()
				subscription = queue
				return HttpServerResponse.stream(
					Stream.make(
						yield* event({
							jsonrpc: "2.0",
							method: "notifications/subscriptions/acknowledged",
							params: {
								notifications: params.notifications,
								_meta: {
									[Mcp.SUBSCRIPTION_ID_META_KEY]: request.id,
									...meta,
								},
							},
						}),
					).pipe(
						Stream.concat(Stream.fromQueue(queue)),
						Stream.encodeText,
						Stream.ensuring(
							Effect.sync(() => {
								subscription = undefined
								state.aborted++
							}),
						),
					),
					{ contentType: "text/event-stream" },
				)
			})
			return yield* Match.value(request.method).pipe(
				Match.when("server/discover", () =>
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
					}),
				),
				Match.when("tools/list", () => {
					state.listReads++
					const listed = Arr.map(tools, (tool) => ({
						...tool,
						description: `revision ${state.revision}`,
					}))
					return reply(
						state.endlessPages
							? {
									tools: [],
									nextCursor: `page-${state.listReads}`,
								}
							: params.cursor === undefined
								? {
										tools: Arr.take(listed, 2),
										nextCursor: "next",
									}
								: {
										tools: Arr.drop(listed, 2),
									},
					)
				}),
				Match.when("resources/list", () =>
					reply({
						resources: [
							{
								uri: "notes://latest",
								name: "Latest",
							},
						],
					}),
				),
				Match.when("resources/templates/list", () =>
					reply({
						resourceTemplates: [
							{
								uriTemplate: "notes://{id}",
								name: "Note",
							},
						],
					}),
				),
				Match.when("resources/read", () =>
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
					}),
				),
				Match.when("prompts/list", () =>
					reply({
						prompts: [{ name: "Summary" }],
					}),
				),
				Match.when("prompts/get", () =>
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
					}),
				),
				Match.when("tools/call", () => callTool),
				Match.when("subscriptions/listen", () => listen),
				Match.orElse(() =>
					Effect.succeed(HttpServerResponse.empty({ status: 400 })),
				),
			)
		}),
	)
	const key = { owner: "alice", connectionId: "notes" }
	const endpoint = fixture.ipOrigin + "/mcp?account=1"
	const cardUrl = fixture.ipOrigin + "/card"
	const record = Store.AppRecord.make({
		cardUrl,
		card: Document.ServerCard.make({
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
		}),
		sources: [],
	})
	const connection = Store.UserConnection.make({
		...key,
		cardUrl,
		endpoint,
		remoteIndex: 0,
		configuration: Redacted.make({}),
		headers: Redacted.make({}),
		state: "Enabled",
		authorization: { _tag: "Unprotected" },
	})
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
						Client.PermissionDenied.make({
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
		/** Waits until a call of the Hang tool runs. */
		hanging: Queue.take(hanging),
		deny: Effect.sync(() => {
			denied = true
		}),
		/** Changes the tool list and tells the subscription about it. */
		change: Effect.gen(function* () {
			state.revision++
			const id = pipe(
				Arr.findLast(
					requests,
					(r) => r.request.method === "subscriptions/listen",
				),
				Option.map((r) => r.request.id),
				Option.getOrUndefined,
			)
			if (subscription !== undefined)
				yield* Queue.offer(
					subscription,
					yield* event({
						jsonrpc: "2.0",
						method: "notifications/tools/list_changed",
						params: {
							_meta: { [Mcp.SUBSCRIPTION_ID_META_KEY]: id, ...meta },
						},
					}),
				)
		}),
	}
})

// A fresh Layer for each provide, like a fresh runtime.
const layersOf = (fixture: Effect.Success<typeof service>) =>
	fixture.layers.pipe(Layer.provideMerge([CatalogDiscovery.layerRules]))

it.live(
	"the protocol client uses live discovery, standard pages, schemas, headers and one shared policy",
	() =>
		Effect.gen(function* () {
			const fixture = yield* service
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
						Arr.some(
							yield* client.modelTools,
							(tool) => tool.name === "AppOnly",
						),
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
					assert.ok(created._tag === "Completed")
					assert.deepStrictEqual(created.result.structuredContent, {
						id: 1,
					})
					const before = fixture.requests.length
					const invalid = yield* Effect.flip(
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
					assert.ok(invalid._tag === "ClientError")
					assert.strictEqual(invalid.reason, "Schema")
					assert.ok(
						Arr.every(
							Arr.drop(fixture.requests, before),
							(r) => r.request.method !== "tools/call",
						),
					)
					const malformed = yield* Effect.result(
						client.callTool(
							{ name: "BadOutput" },
							{ source: "host", readOnly: true },
						),
					)
					assert.ok(malformed._tag === "Failure")
					assert.strictEqual(malformed.failure._tag, "ClientError")
					const failed = yield* Effect.flip(
						client.callTool({ name: "Fail" }, { source: "host" }),
					)
					assert.ok(failed._tag === "ToolFailure")
					const failedContent = failed.result.content[0]
					assert.ok(failedContent?.type === "text")
					assert.strictEqual(failedContent.text, "business rejected")
					yield* client.callTool(
						{
							name: "Mapped",
							arguments: {
								locale: "\uFF2F\uFF2B",
							},
						},
						{ source: "host" },
					)
					assert.deepStrictEqual(
						pipe(
							Arr.findLast(
								fixture.requests,
								(r) => r.request.method === "tools/call",
							),
							Option.flatMap((r) => Headers.get(r.headers, "mcp-param-locale")),
						),
						Option.some("=?base64?77yv77yr?="),
					)
					const resource = yield* client.readTemplate({
						template: "notes://{id}",
						values: { id: "42" },
						source: "model",
					})
					assert.ok(resource._tag === "Completed")
					assert.strictEqual(resource.result.contents[0]?.uri, "notes://42")
					const prompt = yield* client.getPrompt(
						{ name: "Summary" },
						{ source: "model" },
					)
					assert.ok(prompt._tag === "Completed")
					assert.strictEqual(prompt.result.messages[0]?.content.type, "text")
					yield* fixture.deny
					const deniedCount = fixture.requests.length
					for (const source of ["model", "app"] as const) {
						const denied = yield* Effect.flip(
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
						)
						assert.ok(denied._tag === "PermissionDenied")
						assert.strictEqual(denied.action, "tools/call")
						assert.strictEqual(denied.target, "Write")
					}
					assert.strictEqual(fixture.requests.length, deniedCount)
					assert.strictEqual(fixture.state.writes, 1)
					assert.ok(
						Arr.every(
							fixture.requests,
							(r) =>
								r.method === "POST" &&
								r.url === "/mcp?account=1" &&
								!Headers.has(r.headers, "mcp-session-id"),
						),
					)
					assert.ok(
						Arr.every(
							fixture.requests,
							(r) => r.request.method !== "initialize",
						),
					)
					assert.deepStrictEqual(
						pipe(
							Arr.findFirst(
								fixture.requests,
								(r) => r.request.method === "tools/call",
							),
							Option.flatMap((r) =>
								Headers.get(r.headers, "mcp-protocol-version"),
							),
						),
						Option.some(Document.protocolVersion),
					)
				}),
			).pipe(Effect.provide(layersOf(fixture)))
		}).pipe(Effect.provide(NodeServices.layer)),
)

it.live(
	"MRTR stays pending until a capable host explicitly resumes the same operation",
	() =>
		Effect.gen(function* () {
			const fixture = yield* service
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* fixture.prepare
					const noInputs = yield* fixture.connect()
					const pending = yield* noInputs.callTool(
						{ name: "NeedInput" },
						{ source: "host" },
					)
					assert.ok(pending._tag === "InputRequired")
					assert.strictEqual(fixture.state.writes, 0)
					const unavailable = yield* Effect.flip(pending.handle)
					assert.ok(unavailable._tag === "ClientError")
					assert.strictEqual(unavailable.reason, "InputUnavailable")
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
					assert.ok(operation._tag === "InputRequired")
					const completed = yield* operation.handle
					assert.strictEqual(completed._tag, "Completed")
					assert.strictEqual(fixture.state.writes, 1)
					const requests = Arr.filter(
						fixture.requests,
						(r) => r.request.method === "tools/call",
					)
					assert.strictEqual(requests.length, 3)
					assert.strictEqual(
						requests[2]?.request.params?.["requestState"],
						"server-owned-operation-1",
					)
				}),
			).pipe(Effect.provide(layersOf(fixture)))
		}).pipe(Effect.provide(NodeServices.layer)),
)

it.live(
	"SSE progress, explicit subscriptions, cancellation and unknown write outcomes stay distinct",
	() =>
		Effect.gen(function* () {
			const fixture = yield* service
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
								(progress = Arr.append(progress, event.progress)),
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
					yield* fixture.change
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
					yield* fixture.hanging
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
					assert.ok(unknown._tag === "Failure")
					assert.strictEqual(unknown.failure._tag, "OutcomeUnknown")
					assert.strictEqual(fixture.state.writes, 1)
					assert.strictEqual(
						Arr.filter(fixture.requests, (r) => r.params.name === "Drop")
							.length,
						1,
					)
					assert.ok(
						Arr.every(
							fixture.requests,
							(r) => r.request.method !== "notifications/cancelled",
						),
					)
				}),
			).pipe(Effect.provide(layersOf(fixture)))
			assert.strictEqual(fixture.state.aborted, 2)
		}).pipe(Effect.provide(NodeServices.layer)),
)

it.live(
	"Version mismatch fails before tools, and a service that advertises only tools gets no other lists",
	() =>
		Effect.gen(function* () {
			const fixture = yield* service
			fixture.state.versions = ["2025-11-25"]
			const error = yield* Effect.flip(
				Effect.scoped(
					Effect.gen(function* () {
						yield* fixture.prepare
						return yield* fixture.connect()
					}),
				).pipe(Effect.provide(layersOf(fixture))),
			)
			assert.ok(error._tag === "ClientError")
			assert.strictEqual(error.reason, "Protocol")
			assert.ok(
				Arr.every(
					fixture.requests,
					(r) => r.request.method === "server/discover",
				),
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
				Arr.every(fixture.requests, (r) =>
					Arr.contains(["server/discover", "tools/list"], r.request.method),
				),
			)
		}).pipe(Effect.provide(NodeServices.layer)),
)

it.live(
	"input response identifiers cannot collide with a joined identifier",
	() =>
		Effect.gen(function* () {
			const fixture = yield* service
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
		}).pipe(Effect.provide(NodeServices.layer)),
)

it.live(
	"A service that never ends its tool pages stops the walk after 64 pages",
	() =>
		Effect.gen(function* () {
			const fixture = yield* service
			fixture.state.endlessPages = true
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* fixture.prepare
					const client = yield* McpClient.open({
						key: fixture.key,
						clientInfo: { name: "protocol-test-host", version: "1.0.0" },
						eagerLists: false,
					})
					const error = yield* Effect.flip(client.modelTools)
					assert.ok(error._tag === "ClientError")
					assert.strictEqual(error.reason, "Protocol")
					assert.strictEqual(error.issue, "The service sent too many pages")
					assert.strictEqual(fixture.state.listReads, 64)
				}),
			).pipe(Effect.provide(layersOf(fixture)))
		}).pipe(Effect.provide(NodeServices.layer)),
)

it.live(
	"remote failures stay private when a read fails or a write has an unknown result",
	() =>
		Effect.gen(function* () {
			const fixture = yield* service
			fixture.state.protocolError = true
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* fixture.prepare
					const client = yield* fixture.connect()
					const failure = yield* Effect.flip(
						client.callTool(
							{ name: "BadOutput" },
							{ source: "host", readOnly: true },
						),
					)
					assert.ok(failure._tag === "ClientError")
					assert.equal(failure.reason, "Protocol")
					assert.notMatch(
						yield* Schema.encodeEffect(
							Schema.fromJsonString(Client.ClientError),
						)(failure),
						/private-/,
					)
					const original = Client.errorCause(failure)
					assert.ok(Option.isSome(original))
					assert.include(
						Cause.pretty(Redacted.value(original.value)),
						"private-remote-detail",
					)
					const unknown = yield* Effect.flip(
						client.callTool({ name: "BadOutput" }, { source: "host" }),
					)
					assert.ok(unknown._tag === "OutcomeUnknown")
					assert.equal(unknown.cause, "Protocol")
					assert.notMatch(
						yield* Schema.encodeEffect(
							Schema.fromJsonString(Client.OutcomeUnknown),
						)(unknown),
						/private-/,
					)
					const outcome = Client.errorCause(unknown)
					assert.ok(Option.isSome(outcome))
					const cause = Client.errorCause(
						Cause.squash(Redacted.value(outcome.value)),
					)
					assert.ok(Option.isSome(cause))
					assert.include(
						Cause.pretty(Redacted.value(cause.value)),
						"private-remote-detail",
					)
				}),
			).pipe(Effect.provide(layersOf(fixture)))
		}).pipe(Effect.provide(NodeServices.layer)),
)
