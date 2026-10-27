import { assert, layer } from "@effect/vitest"
import {
	Array as Arr,
	Clock,
	Crypto,
	Deferred,
	Effect,
	Exit,
	Layer,
	Number as Num,
	pipe,
	Record as Rec,
	Ref,
	Schema,
	Scope,
	String as Str,
} from "effect"
import { Base64, Base64Url } from "effect/encoding"
import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
} from "effect/http"
import { NodeServices } from "@effect/platform-node"
import {
	CatalogDiscovery,
	Discovery,
	Document,
	Indexing,
	MemoryIndex,
	Network,
	PublicIndexing,
	RobotsPolicy,
} from "@openbot-build/protocol"
import {
	Client,
	SdkError,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import * as Testing from "@openbot-build/protocol-test/testing"

const origin = "https://protocol-test.example.com"
const object = HttpClientResponse.schemaBodyJson(Schema.JsonObject)
const Token = Schema.Struct({
	access_token: Schema.String,
	refresh_token: Schema.optional(Schema.String),
	token_type: Schema.Literal("Bearer"),
	expires_in: Schema.Int,
})
const decodeToken = HttpClientResponse.schemaBodyJson(Token)
const Notes = Schema.Struct({ notes: Schema.Array(Schema.Unknown) })
const decodeRpcError = HttpClientResponse.schemaBodyJson(
	Schema.Struct({
		error: Schema.Struct({ code: Schema.Int, message: Schema.String }),
	}),
)
/** The JSON-RPC code of an InvalidParams error. */
const invalidParams = -32602
const scenarioIds = [
	"anonymous",
	"api-key",
	"bearer",
	"basic",
	"oauth-cimd",
	"oauth-dcr",
	"oauth-preregistered",
	"oauth-client-credentials",
]
const headerScenarios = [
	{ id: "api-key", name: "X-API-Key", value: "protocol-test-api-key" },
	{
		id: "bearer",
		name: "Authorization",
		value: "Bearer protocol-test-bearer-token",
	},
	{
		id: "basic",
		name: "Authorization",
		value: "Basic cHJvdG9jb2wtdGVzdDpwcm90b2NvbC10ZXN0LXBhc3N3b3Jk",
	},
]

/**
 * Runs the service in this process. Requests from `http` and from the MCP
 * clients go to the service without a network. The service stops when the
 * scope closes.
 */
const fixture = Effect.fn(function* (clock?: Clock.Clock) {
	const crypto = yield* Crypto.Crypto
	const handle = yield* Testing.serve(origin, clock)
	const http = (yield* HttpClient.HttpClient).pipe(
		HttpClient.transformResponse(
			Effect.provideService(FetchHttpClient.Fetch, handle),
		),
	)
	const request = (
		path: string,
		options: Omit<HttpClientRequest.Options, "url"> = {},
	) =>
		http.execute(
			HttpClientRequest.make(options.method ?? "GET")(origin + path, options),
		)
	const form = (
		path: string,
		data: Readonly<Record<string, string>>,
		headers: Readonly<Record<string, string>> = {},
	) =>
		http.execute(
			HttpClientRequest.post(origin + path, { headers }).pipe(
				HttpClientRequest.bodyUrlParams(data),
			),
		)
	const rpc = (
		path: string,
		method: string,
		params: Schema.JsonObject = {},
		token?: string,
	) =>
		HttpClientRequest.post(origin + path, {
			headers: {
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": Document.protocolVersion,
				"mcp-method": method,
				...(typeof params["name"] === "string"
					? { "mcp-name": params["name"] }
					: {}),
				...(token === undefined ? {} : { authorization: "Bearer " + token }),
			},
		}).pipe(
			HttpClientRequest.bodyJson({
				jsonrpc: "2.0",
				id: 1,
				method,
				params: {
					_meta: {
						"io.modelcontextprotocol/protocolVersion": Document.protocolVersion,
						"io.modelcontextprotocol/clientCapabilities": {},
						"io.modelcontextprotocol/clientInfo": {
							name: "raw-test-host",
							version: "1.0.0",
						},
					},
					...params,
				},
			}),
			Effect.flatMap(http.execute),
		)
	const connect = (
		id = "anonymous",
		headers: Readonly<Record<string, string>> = {},
		capabilities: Schema.JsonObject = {},
	) =>
		Effect.acquireRelease(
			Effect.gen(function* () {
				const client = new Client(
					{ name: "independent-test-host", version: "1.0.0" },
					{
						versionNegotiation: { mode: { pin: Document.protocolVersion } },
						capabilities,
						inputRequired: { autoFulfill: false },
					},
				)
				yield* Effect.promise(() =>
					client.connect(
						new StreamableHTTPClientTransport(new URL(origin + "/mcp/" + id), {
							requestInit: { headers },
							fetch: handle,
						}),
					),
				)
				return client
			}),
			(client) => Effect.promise(() => client.close()),
		)
	const authorize = Effect.fn(function* (
		options: {
			mode?: string
			client?: string
			account?: string
			scope?: string
			decision?: string
			secretMethod?: string
		} = {},
	) {
		const mode = options.mode ?? "preregistered"
		const client = options.client ?? "protocol-test-public"
		const verifier = pipe("v", Str.repeat(64))
		const resource = origin + "/mcp/oauth-" + mode
		const challenge = yield* crypto
			.digest("SHA-256", new TextEncoder().encode(verifier))
			.pipe(Effect.map(Base64Url.encode))
		const response = yield* request("/oauth/" + mode + "/authorize", {
			urlParams: {
				client_id: client,
				redirect_uri: origin + "/callback",
				response_type: "code",
				resource,
				scope: options.scope ?? "test:read test:write",
				state: "test-state",
				code_challenge_method: "S256",
				code_challenge: challenge,
			},
		})
		const page = yield* response.text
		assert.strictEqual(response.status, 200, page)
		const consent = /name="request" value="([^"]+)"/.exec(page)?.[1]
		assert.ok(consent)
		const decision = yield* form("/consent", {
			request: consent,
			decision: options.decision ?? "allow",
			account: options.account ?? "alice",
		})
		assert.strictEqual(decision.status, 303)
		const callback = new URL(decision.headers["location"] ?? "")
		assert.strictEqual(callback.searchParams.get("state"), "test-state")
		assert.strictEqual(
			callback.searchParams.get("iss"),
			origin + "/oauth/" + mode,
		)
		const code = callback.searchParams.get("code")
		const body = {
			grant_type: "authorization_code",
			client_id: client,
			redirect_uri: origin + "/callback",
			resource,
			code: code ?? "",
			code_verifier: verifier,
		}
		const headers =
			options.secretMethod === "basic"
				? {
						authorization:
							"Basic " + Base64.encode(client + ":protocol-test-client-secret"),
					}
				: {}
		const exchange = form(
			"/oauth/" + mode + "/token",
			{
				...body,
				...(options.secretMethod === "post"
					? { client_secret: "protocol-test-client-secret" }
					: {}),
			},
			headers,
		)
		return { mode, client, resource, body, callback, exchange }
	})
	return { http, request, form, rpc, connect, authorize }
})

// The service in each test runs with real time, as it does in production.
layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer), {
	excludeTestServices: true,
})((it) => {
	it.effect(
		"serves discovery documents, public indexing fixtures, cache validators and CORS",
		() =>
			Effect.gen(function* () {
				const app = yield* fixture()
				const response = yield* app.request("/.well-known/ai-catalog.json")
				assert.strictEqual(
					response.headers["content-type"],
					Document.catalogMediaType,
				)
				const catalog = yield* HttpClientResponse.schemaBodyJson(
					Document.Catalog,
				)(response)
				assert.strictEqual(catalog.entries.length, scenarioIds.length + 2)
				assert.strictEqual(
					(yield* app.request("/.well-known/ai-catalog.json", {
						headers: { "if-none-match": response.headers["etag"] ?? "" },
					})).status,
					304,
				)
				for (const scenario of scenarioIds) {
					const card = yield* app.request(
						"/apps/" + scenario + "/server-card.json",
					)
					assert.strictEqual(card.status, 200)
					assert.strictEqual(
						card.headers["content-type"],
						Document.cardMediaType,
					)
					const value = yield* Effect.flatMap(
						card.json,
						Document.ServerCard.decode,
					)
					assert.strictEqual(
						value.remotes?.[0]?.url,
						origin + "/mcp/" + scenario,
					)
					assert.strictEqual(
						(yield* app.request("/apps/" + scenario + "/server-card.json", {
							headers: {
								"if-modified-since": card.headers["last-modified"] ?? "",
							},
						})).status,
						304,
					)
					const page = yield* app.request("/apps/" + scenario)
					assert.match(yield* page.text, /rel="ai-catalog"/)
				}
				assert.strictEqual(
					(yield* app.request("/fixtures/noindex/server-card.json")).headers[
						"x-robots-tag"
					],
					"noindex",
				)
				const robots = yield* app.request("/robots.txt")
				assert.match(
					yield* robots.text,
					/Disallow: \/fixtures\/robots-denied\//,
				)
				assert.strictEqual(
					(yield* app.request("/fixtures/withdrawn/server-card.json")).status,
					410,
				)
				assert.strictEqual(
					(yield* app.request("/fixtures/unavailable/server-card.json")).status,
					503,
				)
				assert.strictEqual(
					(yield* app.request("/fixtures/redirect/server-card.json")).status,
					302,
				)
				const preflight = yield* app.request("/mcp/oauth-cimd", {
					method: "OPTIONS",
					headers: {
						origin: "https://host.example",
						"access-control-request-method": "POST",
					},
				})
				assert.strictEqual(preflight.status, 204)
				assert.strictEqual(
					preflight.headers["access-control-allow-origin"],
					"https://host.example",
				)
				assert.strictEqual(
					(yield* app.request("/mcp/anonymous", {
						method: "OPTIONS",
						headers: { origin: "https://hostile.example" },
					})).status,
					403,
				)
			}),
	)

	it.effect(
		"an independent MCP client uses structured tools, pagination, resources, templates, completion, prompts and Apps",
		() =>
			Effect.gen(function* () {
				const app = yield* fixture()
				const client = yield* app.connect()
				const tools = yield* Effect.promise(() => client.listTools())
				assert.ok(
					Arr.some(
						tools.tools,
						(tool) =>
							tool.name === "write_note" && tool.outputSchema !== undefined,
					),
				)
				assert.deepStrictEqual(
					(yield* Effect.promise(() =>
						client.callTool({ name: "echo", arguments: { text: "hello" } }),
					)).structuredContent,
					{ text: "hello", scenario: "anonymous" },
				)
				assert.deepStrictEqual(
					(yield* Effect.promise(() =>
						client.callTool({ name: "add", arguments: { a: 2, b: 3 } }),
					)).structuredContent,
					{ sum: 5 },
				)
				const input = {
					workspace: "test-workspace",
					text: "A synthetic note",
					idempotencyKey: "first",
				}
				const first = yield* Effect.promise(() =>
					client.callTool({ name: "write_note", arguments: input }),
				)
				assert.deepStrictEqual(
					(yield* Effect.promise(() =>
						client.callTool({ name: "write_note", arguments: input }),
					)).structuredContent,
					first.structuredContent,
				)
				assert.strictEqual(
					(yield* Effect.promise(() =>
						client.callTool({
							name: "write_note",
							arguments: { ...input, text: "changed" },
						}),
					)).isError,
					true,
				)
				assert.strictEqual(
					(yield* Effect.promise(() =>
						client.callTool({
							name: "delete_note",
							arguments: {
								workspace: input.workspace,
								id: "1",
								expectedRevision: 0,
							},
						}),
					)).isError,
					true,
				)
				const resource = yield* Effect.promise(() =>
					client.readResource({
						uri: "protocol-test://workspace/test-workspace",
					}),
				)
				assert.ok(
					Arr.some(
						resource.contents,
						(content) =>
							"text" in content &&
							pipe(content.text, Str.includes("A synthetic note")),
					),
				)
				const samples = yield* Effect.promise(() =>
					client.callTool({ name: "content_samples", arguments: {} }),
				)
				assert.deepStrictEqual(
					Arr.map(samples.content, (entry) => entry.type),
					["text", "image", "audio", "resource", "resource_link"],
				)
				const binary = yield* Effect.promise(() =>
					client.readResource({ uri: "protocol-test://binary" }),
				)
				assert.ok(
					Arr.some(
						binary.contents,
						(content) => "blob" in content && content.blob === "AAECf4D/",
					),
				)
				const wire = yield* app.rpc("/mcp/anonymous", "resources/list")
				const wirePage = yield* object(wire)
				assert.ok(wirePage["result"], yield* wire.text)
				const initial = yield* Schema.decodeUnknownEffect(
					Schema.Struct({
						result: Schema.Struct({
							nextCursor: Schema.String,
							resources: Schema.Array(Schema.Unknown),
						}),
					}),
				)(wirePage)
				assert.ok(initial.result.nextCursor)
				assert.strictEqual(initial.result.resources.length, 20)
				let listed = yield* Effect.promise(() =>
					client.listResources({ cursor: initial.result.nextCursor }),
				)
				let count = initial.result.resources.length + listed.resources.length
				assert.ok(
					listed.nextCursor,
					"The service must return more than one page",
				)
				while (listed.nextCursor !== undefined) {
					const cursor = listed.nextCursor
					listed = yield* Effect.promise(() => client.listResources({ cursor }))
					count += listed.resources.length
				}
				assert.strictEqual(count, 113)
				const templates = yield* Effect.promise(() =>
					client.listResourceTemplates(),
				)
				assert.ok(
					Arr.some(templates.resourceTemplates, (template) =>
						pipe(
							template.uriTemplate,
							Str.startsWith("protocol-test://workspace/"),
						),
					),
				)
				const completed = yield* Effect.promise(() =>
					client.complete({
						ref: { type: "ref/prompt", name: "summarize_workspace" },
						argument: { name: "style", value: "b" },
					}),
				)
				assert.deepStrictEqual(completed.completion.values, ["brief"])
				assert.ok(
					(yield* Effect.promise(() =>
						client.getPrompt({
							name: "summarize_workspace",
							arguments: { workspace: "demo" },
						}),
					)).messages.length > 0,
				)
				assert.strictEqual(
					(yield* Effect.promise(() =>
						client.callTool({
							name: "test_error",
							arguments: { message: "expected failure" },
						}),
					)).isError,
					true,
				)
				const ui = yield* Effect.promise(() =>
					client.readResource({ uri: "ui://protocol-test/workspace.html" }),
				)
				assert.strictEqual(ui.contents[0]?.mimeType, Document.uiMediaType)
				assert.ok(
					Arr.some(
						ui.contents,
						(content) =>
							"text" in content &&
							pipe(content.text, Str.includes("ui_read_workspace")) &&
							pipe(content.text, Str.includes("ui/initialize")),
					),
				)
				assert.strictEqual(
					(yield* Effect.promise(() =>
						client.callTool({ name: "echo", arguments: { text: 1 } }),
					)).isError,
					true,
				)
			}),
	)

	it.effect(
		"configured headers reject invalid access and let independent MCP clients connect",
		() =>
			Effect.gen(function* () {
				const app = yield* fixture()
				for (const scenario of headerScenarios) {
					assert.strictEqual(
						(yield* app.rpc("/mcp/" + scenario.id, "server/discover")).status,
						401,
					)
					const result = yield* Effect.scoped(
						Effect.flatMap(
							app.connect(scenario.id, { [scenario.name]: scenario.value }),
							(client) =>
								Effect.promise(() =>
									client.callTool({
										name: "echo",
										arguments: { text: "authorized" },
									}),
								),
						),
					)
					assert.strictEqual(result.isError, undefined)
				}
			}),
	)

	it.effect(
		"OAuth checks code binding, consent denial, refresh rotation, scope, audience, account isolation and revocation",
		() =>
			Effect.gen(function* () {
				const app = yield* fixture()
				const denied = yield* app.authorize({ decision: "deny" })
				assert.strictEqual(
					denied.callback.searchParams.get("error"),
					"access_denied",
				)
				const alice = yield* app.authorize()
				assert.strictEqual(
					(yield* app.form("/oauth/preregistered/token", {
						...alice.body,
						code_verifier: pipe("x", Str.repeat(64)),
					})).status,
					400,
				)
				const response = yield* alice.exchange
				assert.strictEqual(response.status, 200, yield* response.text)
				const token = yield* decodeToken(response)
				assert.strictEqual((yield* alice.exchange).status, 400)
				assert.strictEqual(
					(yield* app.rpc(
						"/mcp/oauth-cimd",
						"server/discover",
						{},
						token.access_token,
					)).status,
					401,
				)
				yield* Effect.scoped(
					Effect.flatMap(
						app.connect("oauth-preregistered", {
							authorization: "Bearer " + token.access_token,
						}),
						(client) =>
							Effect.promise(() =>
								client.callTool({
									name: "write_note",
									arguments: {
										workspace: "private",
										text: "Alice only",
										idempotencyKey: "alice",
									},
								}),
							),
					),
				)
				const bob = yield* app.authorize({ account: "bob" })
				const bobToken = yield* Effect.flatMap(bob.exchange, decodeToken)
				const data = yield* Effect.scoped(
					Effect.flatMap(
						app.connect("oauth-preregistered", {
							authorization: "Bearer " + bobToken.access_token,
						}),
						(client) =>
							Effect.promise(() =>
								client.callTool({
									name: "read_workspace",
									arguments: { workspace: "private" },
								}),
							),
					),
				)
				assert.deepStrictEqual(
					(yield* Schema.decodeUnknownEffect(Notes)(data.structuredContent))
						.notes,
					[],
				)
				const readOnly = yield* app.authorize({ scope: "test:read" })
				const readToken = yield* Effect.flatMap(readOnly.exchange, decodeToken)
				const readTools = yield* Effect.scoped(
					Effect.flatMap(
						app.connect("oauth-preregistered", {
							authorization: "Bearer " + readToken.access_token,
						}),
						(client) => Effect.promise(() => client.listTools()),
					),
				)
				assert.ok(
					!Arr.some(readTools.tools, (tool) => tool.name === "write_note"),
				)
				const insufficient = yield* app.rpc(
					"/mcp/oauth-preregistered",
					"tools/call",
					{
						name: "write_note",
						arguments: {
							workspace: "private",
							text: "blocked",
							idempotencyKey: "blocked",
						},
					},
					readToken.access_token,
				)
				assert.strictEqual(insufficient.status, 403)
				assert.match(
					insufficient.headers["www-authenticate"] ?? "",
					/test:write/,
				)
				const refreshForm = {
					grant_type: "refresh_token",
					client_id: alice.client,
					resource: alice.resource,
					refresh_token: token.refresh_token ?? "",
				}
				const refreshed = yield* app.form(
					"/oauth/preregistered/token",
					refreshForm,
				)
				assert.strictEqual(refreshed.status, 200)
				const next = yield* decodeToken(refreshed)
				assert.strictEqual(
					(yield* app.form("/oauth/preregistered/token", refreshForm)).status,
					400,
				)
				assert.strictEqual(
					(yield* app.form("/oauth/preregistered/revoke", {
						client_id: alice.client,
						token: next.access_token,
					})).status,
					200,
				)
				assert.strictEqual(
					(yield* app.rpc(
						"/mcp/oauth-preregistered",
						"server/discover",
						{},
						token.access_token,
					)).status,
					401,
				)
				assert.strictEqual(
					(yield* app.rpc(
						"/mcp/oauth-preregistered",
						"server/discover",
						{},
						next.access_token,
					)).status,
					401,
				)
			}),
	)

	it.effect(
		"CIMD, dynamic registration, confidential Basic/POST and client credentials are real token flows",
		() =>
			Effect.gen(function* () {
				const app = yield* fixture()
				const cimd = yield* app.authorize({
					mode: "cimd",
					client: "https://client.example/client.json",
				})
				assert.strictEqual((yield* cimd.exchange).status, 200)
				const registration = yield* HttpClientRequest.post(
					origin + "/oauth/dcr/register",
				).pipe(
					HttpClientRequest.bodyJson({
						client_name: "Independent dynamic host",
						redirect_uris: [origin + "/callback"],
						token_endpoint_auth_method: "none",
					}),
					Effect.flatMap(app.http.execute),
				)
				assert.strictEqual(registration.status, 201)
				const data = yield* object(registration)
				assert.strictEqual(typeof data["client_id"], "string")
				const dynamic = yield* app.authorize({
					mode: "dcr",
					client: String(data["client_id"]),
				})
				assert.strictEqual((yield* dynamic.exchange).status, 200)
				for (const method of ["basic", "post"]) {
					const grant = yield* app.authorize({
						client: "protocol-test-confidential-" + method,
						secretMethod: method,
					})
					assert.strictEqual((yield* grant.exchange).status, 200)
				}
				const machine = yield* app.form("/oauth/client-credentials/token", {
					grant_type: "client_credentials",
					client_id: "protocol-test-confidential-post",
					client_secret: "protocol-test-client-secret",
					resource: origin + "/mcp/oauth-client-credentials",
					scope: "test:read",
				})
				assert.strictEqual(machine.status, 200)
				assert.strictEqual((yield* object(machine))["refresh_token"], undefined)
				assert.strictEqual(
					(yield* app.form("/oauth/client-credentials/token", {
						grant_type: "client_credentials",
						client_id: "protocol-test-public",
						resource: origin + "/mcp/oauth-client-credentials",
					})).status,
					400,
				)
				assert.strictEqual(
					(yield* app.form("/oauth/client-credentials/token", {
						grant_type: "client_credentials",
						client_id: "protocol-test-confidential-post",
						client_secret: "wrong",
						resource: origin + "/mcp/oauth-client-credentials",
					})).status,
					401,
				)
			}),
	)

	it.effect(
		"CIMD and dynamic registration errors give the client the reason",
		() =>
			Effect.gen(function* () {
				const app = yield* fixture()
				const oauthError = HttpClientResponse.schemaBodyJson(
					Schema.Struct({
						error: Schema.String,
						error_description: Schema.String,
					}),
				)
				const cimd = yield* app.request("/oauth/cimd/authorize", {
					urlParams: {
						client_id: "http://client.example/client.json",
						redirect_uri: origin + "/callback",
					},
				})
				assert.strictEqual(cimd.status, 401)
				const cimdError = yield* oauthError(cimd)
				assert.strictEqual(cimdError.error, "invalid_client")
				assert.match(
					cimdError.error_description,
					/^The client metadata or redirect URI is not valid: Expected an absolute HTTPS URL/,
				)
				const registration = yield* HttpClientRequest.post(
					origin + "/oauth/dcr/register",
				).pipe(
					HttpClientRequest.bodyJson({ redirect_uris: [] }),
					Effect.flatMap(app.http.execute),
				)
				assert.strictEqual(registration.status, 400)
				const registrationError = yield* oauthError(registration)
				assert.strictEqual(registrationError.error, "invalid_client_metadata")
				assert.match(
					registrationError.error_description,
					/^The registration document is not valid: ./,
				)
			}),
	)

	it.effect(
		"standard keyed inputs resume form, URL, sampling and roots operations and reject replay",
		() =>
			Effect.gen(function* () {
				const app = yield* fixture()
				const meta = {
					"io.modelcontextprotocol/protocolVersion": Document.protocolVersion,
					"io.modelcontextprotocol/clientCapabilities": {
						elicitation: { form: {}, url: {} },
						sampling: {},
						roots: {},
					},
					"io.modelcontextprotocol/clientInfo": {
						name: "continuation-test",
						version: "1.0.0",
					},
				}
				const responses: Readonly<Record<string, Schema.JsonObject>> = {
					form: { action: "accept", content: { label: "Synthetic label" } },
					url: { action: "accept" },
					sampling: {
						model: "synthetic-model",
						role: "assistant",
						content: { type: "text", text: "Synthetic response" },
					},
					roots: {
						roots: [{ uri: "file:///synthetic", name: "Synthetic root" }],
					},
				}
				const call = (params: Schema.JsonObject) =>
					app.rpc("/mcp/anonymous", "tools/call", params)
				for (const [kind, input] of Rec.toEntries(responses)) {
					const original = {
						name: "request_" + kind,
						arguments: { text: "Synthetic request" },
						_meta: meta,
					}
					const started = yield* Effect.flatMap(call(original), object)
					const pending = yield* Schema.decodeUnknownEffect(
						Schema.Struct({
							result: Schema.Struct({
								resultType: Schema.Literal("input_required"),
								requestState: Schema.String,
								inputRequests: Schema.JsonObject,
							}),
						}),
					)(started)
					assert.ok(pending.result.inputRequests["input"])
					const resumed = {
						...original,
						requestState: pending.result.requestState,
						inputResponses: { input },
					}
					const wrong = yield* call({
						...resumed,
						arguments: { text: "Changed request" },
					})
					assert.strictEqual(
						(yield* decodeRpcError(wrong)).error.code,
						invalidParams,
						yield* wrong.text,
					)
					const completed = yield* call(resumed)
					assert.ok((yield* object(completed))["result"], yield* completed.text)
					const replayed = yield* call(resumed)
					assert.strictEqual(
						(yield* decodeRpcError(replayed)).error.code,
						invalidParams,
						yield* replayed.text,
					)
				}
			}),
	)

	it.effect(
		"subscriptions, progress, logs and cancellation use the selected MCP transport",
		() =>
			Effect.gen(function* () {
				const app = yield* fixture()
				const client = yield* app.connect()
				// The MCP client calls these handlers outside of Effect.
				const run = Effect.runSyncWith(yield* Effect.context<never>())
				const progress = yield* Ref.make(0)
				const logs = yield* Ref.make(0)
				const changed = yield* Ref.make(0)
				const updated = yield* Ref.make(0)
				const toolsChanged = yield* Deferred.make<void>()
				const resourceUpdate = yield* Deferred.make<void>()
				client.setNotificationHandler("notifications/message", () =>
					run(Ref.update(logs, Num.increment)),
				)
				// This notification comes on the listen stream and not in the call response, so the test waits for it.
				client.setNotificationHandler("notifications/tools/list_changed", () =>
					run(
						Ref.update(changed, Num.increment).pipe(
							Effect.andThen(Deferred.succeed(toolsChanged, undefined)),
							Effect.asVoid,
						),
					),
				)
				client.setNotificationHandler("notifications/resources/updated", () =>
					run(
						Ref.update(updated, Num.increment).pipe(
							Effect.andThen(Deferred.succeed(resourceUpdate, undefined)),
							Effect.asVoid,
						),
					),
				)
				yield* Effect.acquireRelease(
					Effect.promise(() =>
						client.listen({
							toolsListChanged: true,
							resourceSubscriptions: ["protocol-test://workspace/subscribed"],
						}),
					),
					(subscription) => Effect.promise(() => subscription.close()),
				)
				yield* Effect.promise(() =>
					client.callTool(
						{
							name: "wait",
							arguments: { milliseconds: 10 },
							_meta: { "io.modelcontextprotocol/logLevel": "info" },
						},
						{ onprogress: () => run(Ref.update(progress, Num.increment)) },
					),
				)
				assert.strictEqual(yield* Ref.get(progress), 5)
				assert.strictEqual(yield* Ref.get(logs), 1)
				yield* Effect.promise(() =>
					client.callTool({ name: "notify", arguments: {} }),
				)
				yield* Effect.promise(() =>
					client.callTool({
						name: "write_note",
						arguments: {
							workspace: "subscribed",
							text: "Subscription fixture",
							idempotencyKey: "first",
						},
					}),
				)
				yield* Deferred.await(toolsChanged)
				assert.ok((yield* Ref.get(changed)) > 0)
				yield* Deferred.await(resourceUpdate)
				assert.ok((yield* Ref.get(updated)) > 0)
				// The first progress report closes this scope, and that aborts the call.
				const call = yield* Scope.fork(yield* Effect.scope)
				const signal = yield* Scope.provide(call)(Effect.abortSignal)
				const cancelled = yield* Effect.flip(
					Effect.tryPromise(() =>
						client.callTool(
							{ name: "wait", arguments: { milliseconds: 10000 } },
							{ signal, onprogress: () => run(Scope.close(call, Exit.void)) },
						),
					),
				)
				assert.ok(signal.aborted)
				// The SDK gives the same error code for an abort and a timeout, so the test reads the message.
				assert.instanceOf(cancelled.cause, SdkError)
				assert.include(cancelled.cause.message, "AbortError")
				assert.deepStrictEqual(
					(yield* Effect.promise(() =>
						client.callTool({
							name: "echo",
							arguments: { text: "still usable" },
						}),
					)).structuredContent,
					{ scenario: "anonymous", text: "still usable" },
				)
			}),
		{ timeout: 10000 },
	)

	it.effect(
		"a controlled clock makes codes, access tokens, refresh grants and workspaces expire",
		() =>
			Effect.gen(function* () {
				const live = yield* Clock.Clock
				const now = yield* Ref.make(yield* live.currentTimeMillis)
				const advance = (millis: number) => Ref.update(now, Num.sum(millis))
				const clock: Clock.Clock = {
					currentTimeMillis: Ref.get(now),
					currentTimeMillisUnsafe: () => Ref.getUnsafe(now),
					currentTimeNanos: live.currentTimeNanos,
					currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
					monotonicTimeNanos: live.monotonicTimeNanos,
					monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
					sleep: (duration) => live.sleep(duration),
				}
				const app = yield* fixture(clock)
				const expiredCode = yield* app.authorize()
				yield* advance(60_001)
				assert.strictEqual((yield* expiredCode.exchange).status, 400)
				const grant = yield* app.authorize()
				const tokens = yield* Effect.flatMap(grant.exchange, decodeToken)
				const client = yield* app.connect()
				yield* Effect.promise(() =>
					client.callTool({
						name: "write_note",
						arguments: {
							workspace: "expires",
							text: "Temporary",
							idempotencyKey: "first",
						},
					}),
				)
				yield* advance(300_001)
				assert.strictEqual(
					(yield* app.rpc(
						"/mcp/oauth-preregistered",
						"server/discover",
						{},
						tokens.access_token,
					)).status,
					401,
				)
				const refresh = app.form("/oauth/preregistered/token", {
					client_id: grant.client,
					resource: grant.resource,
					grant_type: "refresh_token",
					refresh_token: tokens.refresh_token ?? "",
				})
				assert.strictEqual((yield* refresh).status, 200)
				yield* advance(1_800_001)
				const view = yield* Effect.promise(() =>
					client.callTool({
						name: "read_workspace",
						arguments: { workspace: "expires" },
					}),
				)
				assert.deepStrictEqual(
					(yield* Schema.decodeUnknownEffect(Notes)(view.structuredContent))
						.notes,
					[],
				)
				yield* advance(3_600_001)
				assert.strictEqual((yield* refresh).status, 400)
			}),
	)

	it.effect(
		"protocol discovery and anonymous public indexing read the published fixtures",
		() =>
			Effect.gen(function* () {
				const app = yield* fixture()
				const readDocument: Network.PublicNetwork["Service"]["readDocument"] = (
					input,
				) =>
					app.http
						.get(input.url, {
							headers:
								input.validators?.etag === undefined
									? {}
									: { "if-none-match": input.validators.etag },
						})
						.pipe(
							Effect.flatMap((response) =>
								Effect.map(response.text, (text) => ({
									url: input.url,
									status: response.status,
									headers: response.headers,
									text,
								})),
							),
							Effect.tapError((error) =>
								Effect.logError("The fixture document request failed.", error),
							),
							Effect.mapError((error) =>
								Network.NetworkError.make({
									reason: "Transport",
									message: "Fixture document request failed. " + error.message,
								}),
							),
						)
				const publicNetwork = Layer.succeed(Network.PublicNetwork, {
					readDocument,
				})
				const network = Layer.succeed(Network.Network, {
					identity: { owner: "discovery-test", scope: "public" },
					readDocument: (input) => readDocument(input),
					execute: () =>
						Effect.die(new Error("Discovery must not send business requests")),
				})
				const rules = CatalogDiscovery.layerRules
				const discovery = CatalogDiscovery.layer().pipe(
					Layer.provide(network),
					Layer.provide(rules),
				)
				const indexing = PublicIndexing.layer.pipe(
					Layer.provide(RobotsPolicy.layer),
					Layer.provideMerge(Layer.merge(publicNetwork, MemoryIndex.layer)),
					Layer.provide(rules),
				)
				const services = yield* Layer.build(Layer.merge(discovery, indexing))
				const resolve = (input: string) =>
					Discovery.resolve(input).pipe(
						Effect.map((result) => result._tag),
						Effect.provideContext(services),
					)
				const sync = (cardUrl: string) =>
					Indexing.sync(Indexing.Input.make({ cardUrl })).pipe(
						Effect.map((result) => result._tag),
						Effect.provideContext(services),
					)
				assert.strictEqual(yield* resolve(origin + "/apps/anonymous"), "Single")
				assert.strictEqual(
					yield* resolve("protocol-test.example.com"),
					"Multiple",
				)
				assert.strictEqual(
					yield* sync(origin + "/apps/anonymous/server-card.json"),
					"Indexed",
				)
				assert.strictEqual(
					yield* sync(origin + "/fixtures/noindex/server-card.json"),
					"Excluded",
				)
				assert.strictEqual(
					yield* sync(origin + "/fixtures/robots-denied/server-card.json"),
					"Excluded",
				)
				assert.strictEqual(
					yield* sync(origin + "/fixtures/unlisted/server-card.json"),
					"Excluded",
				)
			}),
	)
})
