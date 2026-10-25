import { readFile } from "node:fs/promises"
import { assert, expect, it } from "@effect/vitest"
import { createHash } from "node:crypto"
import { Clock, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { NodeServices } from "@effect/platform-node"
import { HttpRouter } from "effect/http"
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
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import * as Authorization from "../src/Authorization.ts"
import * as Service from "../src/Service.ts"
import { scenarios, Settings } from "../src/Scenarios.ts"

const origin = "https://protocol-test.example.com"
const object = async (response: Response) =>
	Schema.decodeUnknownSync(Schema.JsonObject)(await response.json())
const Token = Schema.Struct({
	access_token: Schema.String,
	refresh_token: Schema.optional(Schema.String),
	token_type: Schema.Literal("Bearer"),
	expires_in: Schema.Int,
})
const fixture = async (clock?: Clock.Clock) => {
	const uiHtml = await readFile(
		new URL("../dist/ui.html", import.meta.url),
		"utf8",
	)
	const network = Layer.succeed(Network.Network, {
		identity: { owner: "test", scope: "public" },
		readDocument: (input) =>
			Effect.succeed({
				url: input.url,
				status: 200,
				headers: { "content-type": "application/json" },
				text: JSON.stringify({
					client_id: input.url,
					client_name: "Independent CIMD client",
					redirect_uris: [origin + "/callback"],
					token_endpoint_auth_method: "none",
					grant_types: ["authorization_code", "refresh_token"],
					response_types: ["code"],
				}),
			}),
		execute: () => Effect.die(new Error("Unexpected business network request")),
	})
	const routes = Service.layer(
		Schema.decodeSync(Settings)({
			origin,
			allowedOrigins: [origin, "https://host.example"],
			uiHtml,
			guideMarkdown: await readFile(
				new URL("../guide.md", import.meta.url),
				"utf8",
			),
		}),
	).pipe(
		Layer.provide(Authorization.layer(origin).pipe(Layer.provide(network))),
		Layer.provide(NodeServices.layer),
		Layer.provideMerge(
			clock === undefined ? Layer.empty : Layer.succeed(Clock.Clock, clock),
		),
	)
	const app = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const request = (path: string, init?: RequestInit) =>
		app.handler(new Request(origin + path, init))
	const form = (
		path: string,
		data: Readonly<Record<string, string>>,
		headers: Readonly<Record<string, string>> = {},
	) =>
		request(path, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				...headers,
			},
			body: new URLSearchParams(data).toString(),
		})
	const rpc = async (
		path: string,
		method: string,
		params: Schema.JsonObject = {},
		token?: string,
	) => {
		const response = await request(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": Document.protocolVersion,
				"mcp-method": method,
				...(typeof params["name"] === "string"
					? { "mcp-name": params["name"] }
					: {}),
				...(token === undefined ? {} : { authorization: "Bearer " + token }),
			},
			body: JSON.stringify({
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
		})
		return response
	}
	const connect = async (
		id = "anonymous",
		headers: Readonly<Record<string, string>> = {},
		capabilities: Schema.JsonObject = {},
	) => {
		const client = new Client(
			{ name: "independent-test-host", version: "1.0.0" },
			{
				versionNegotiation: { mode: { pin: Document.protocolVersion } },
				capabilities,
				inputRequired: { autoFulfill: false },
			},
		)
		await client.connect(
			new StreamableHTTPClientTransport(new URL(origin + "/mcp/" + id), {
				requestInit: { headers },
				fetch: (input, init) => app.handler(new Request(input, init)),
			}),
		)
		return client
	}
	const authorize = async (
		options: {
			mode?: string
			client?: string
			account?: string
			scope?: string
			decision?: string
			secretMethod?: string
		} = {},
	) => {
		const mode = options.mode ?? "preregistered"
		const client = options.client ?? "protocol-test-public"
		const verifier = "v".repeat(64)
		const resource = origin + "/mcp/oauth-" + mode
		const params = new URLSearchParams({
			client_id: client,
			redirect_uri: origin + "/callback",
			response_type: "code",
			resource,
			scope: options.scope ?? "test:read test:write",
			state: "test-state",
			code_challenge_method: "S256",
			code_challenge: createHash("sha256").update(verifier).digest("base64url"),
		})
		const response = await request("/oauth/" + mode + "/authorize?" + params)
		assert.strictEqual(response.status, 200, await response.clone().text())
		const consent = /name="request" value="([^"]+)"/.exec(
			await response.text(),
		)?.[1]
		assert.ok(consent)
		const decision = await form("/consent", {
			request: consent,
			decision: options.decision ?? "allow",
			account: options.account ?? "alice",
		})
		assert.strictEqual(decision.status, 303)
		const callback = new URL(decision.headers.get("location") ?? "")
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
							"Basic " +
							Buffer.from(client + ":protocol-test-client-secret").toString(
								"base64",
							),
					}
				: {}
		const exchange = () =>
			form(
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
	}
	return { ...app, request, form, rpc, connect, authorize }
}

it("serves discovery documents, public indexing fixtures, cache validators and CORS", async () => {
	const app = await fixture()
	try {
		const response = await app.request("/.well-known/ai-catalog.json")
		assert.strictEqual(
			response.headers.get("content-type"),
			Document.catalogMediaType,
		)
		const catalog = Schema.decodeUnknownSync(Document.Catalog)(
			await response.json(),
		)
		assert.strictEqual(catalog.entries.length, scenarios.length + 2)
		assert.strictEqual(
			(
				await app.request("/.well-known/ai-catalog.json", {
					headers: { "if-none-match": response.headers.get("etag") ?? "" },
				})
			).status,
			304,
		)
		for (const scenario of scenarios) {
			const card = await app.request(
				"/apps/" + scenario.id + "/server-card.json",
			)
			assert.strictEqual(card.status, 200)
			assert.strictEqual(
				card.headers.get("content-type"),
				Document.cardMediaType,
			)
			const value = await Effect.runPromise(
				Document.ServerCard.decode(await card.json()),
			)
			assert.strictEqual(
				value.remotes?.[0]?.url,
				origin + "/mcp/" + scenario.id,
			)
			assert.strictEqual(
				(
					await app.request("/apps/" + scenario.id + "/server-card.json", {
						headers: {
							"if-modified-since": card.headers.get("last-modified") ?? "",
						},
					})
				).status,
				304,
			)
			assert.match(
				await (await app.request("/apps/" + scenario.id)).text(),
				/rel="ai-catalog"/,
			)
		}
		assert.strictEqual(
			(await app.request("/fixtures/noindex/server-card.json")).headers.get(
				"x-robots-tag",
			),
			"noindex",
		)
		assert.match(
			await (await app.request("/robots.txt")).text(),
			/Disallow: \/fixtures\/robots-denied\//,
		)
		assert.strictEqual(
			(await app.request("/fixtures/withdrawn/server-card.json")).status,
			410,
		)
		assert.strictEqual(
			(await app.request("/fixtures/unavailable/server-card.json")).status,
			503,
		)
		assert.strictEqual(
			(await app.request("/fixtures/redirect/server-card.json")).status,
			302,
		)
		const preflight = await app.request("/mcp/oauth-cimd", {
			method: "OPTIONS",
			headers: {
				origin: "https://host.example",
				"access-control-request-method": "POST",
			},
		})
		assert.strictEqual(preflight.status, 204)
		assert.strictEqual(
			preflight.headers.get("access-control-allow-origin"),
			"https://host.example",
		)
		assert.strictEqual(
			(
				await app.request("/mcp/anonymous", {
					method: "OPTIONS",
					headers: { origin: "https://hostile.example" },
				})
			).status,
			403,
		)
	} finally {
		await app.dispose()
	}
})

it("an independent MCP client uses structured tools, pagination, resources, templates, completion, prompts and Apps", async () => {
	const app = await fixture()
	const client = await app.connect()
	try {
		const tools = await client.listTools()
		assert.ok(
			tools.tools.some(
				(tool) => tool.name === "write_note" && tool.outputSchema !== undefined,
			),
		)
		assert.deepStrictEqual(
			(await client.callTool({ name: "echo", arguments: { text: "hello" } }))
				.structuredContent,
			{ text: "hello", scenario: "anonymous" },
		)
		assert.deepStrictEqual(
			(await client.callTool({ name: "add", arguments: { a: 2, b: 3 } }))
				.structuredContent,
			{ sum: 5 },
		)
		const input = {
			workspace: "test-workspace",
			text: "A synthetic note",
			idempotencyKey: "first",
		}
		const first = await client.callTool({
			name: "write_note",
			arguments: input,
		})
		assert.deepStrictEqual(
			(await client.callTool({ name: "write_note", arguments: input }))
				.structuredContent,
			first.structuredContent,
		)
		assert.strictEqual(
			(
				await client.callTool({
					name: "write_note",
					arguments: { ...input, text: "changed" },
				})
			).isError,
			true,
		)
		assert.strictEqual(
			(
				await client.callTool({
					name: "delete_note",
					arguments: {
						workspace: input.workspace,
						id: "1",
						expectedRevision: 0,
					},
				})
			).isError,
			true,
		)
		const resource = await client.readResource({
			uri: "protocol-test://workspace/test-workspace",
		})
		assert.ok(
			resource.contents.some(
				(content) =>
					"text" in content && content.text.includes("A synthetic note"),
			),
		)
		const samples = await client.callTool({
			name: "content_samples",
			arguments: {},
		})
		assert.deepStrictEqual(
			samples.content.map((entry) => entry.type),
			["text", "image", "audio", "resource", "resource_link"],
		)
		const binary = await client.readResource({ uri: "protocol-test://binary" })
		assert.ok(
			binary.contents.some(
				(content) => "blob" in content && content.blob === "AAECf4D/",
			),
		)
		const wirePage = await object(
			await app.rpc("/mcp/anonymous", "resources/list"),
		)
		assert.ok(wirePage["result"], JSON.stringify(wirePage))
		const initial = Schema.decodeUnknownSync(
			Schema.Struct({
				result: Schema.Struct({
					nextCursor: Schema.String,
					resources: Schema.Array(Schema.Unknown),
				}),
			}),
		)(wirePage)
		assert.ok(initial.result.nextCursor)
		assert.strictEqual(initial.result.resources.length, 20)
		let listed = await client.listResources({
			cursor: initial.result.nextCursor,
		})
		let count = initial.result.resources.length + listed.resources.length
		assert.ok(listed.nextCursor, "The service must return more than one page")
		while (listed.nextCursor !== undefined) {
			listed = await client.listResources({ cursor: listed.nextCursor })
			count += listed.resources.length
		}
		assert.strictEqual(count, 113)
		assert.ok(
			(await client.listResourceTemplates()).resourceTemplates.some(
				(template) =>
					template.uriTemplate.startsWith("protocol-test://workspace/"),
			),
		)
		const completed = await client.complete({
			ref: { type: "ref/prompt", name: "summarize_workspace" },
			argument: { name: "style", value: "b" },
		})
		assert.deepStrictEqual(completed.completion.values, ["brief"])
		assert.ok(
			(
				await client.getPrompt({
					name: "summarize_workspace",
					arguments: { workspace: "demo" },
				})
			).messages.length > 0,
		)
		assert.strictEqual(
			(
				await client.callTool({
					name: "test_error",
					arguments: { message: "expected failure" },
				})
			).isError,
			true,
		)
		const ui = await client.readResource({
			uri: "ui://protocol-test/workspace.html",
		})
		assert.strictEqual(ui.contents[0]?.mimeType, Document.uiMediaType)
		assert.ok(
			ui.contents.some(
				(content) =>
					"text" in content &&
					content.text.includes("ui_read_workspace") &&
					content.text.includes("ui/initialize"),
			),
		)
		assert.strictEqual(
			(await client.callTool({ name: "echo", arguments: { text: 1 } })).isError,
			true,
		)
	} finally {
		await client.close()
		await app.dispose()
	}
})

it("configured headers reject invalid access and let independent MCP clients connect", async () => {
	const app = await fixture()
	try {
		for (const scenario of scenarios.filter(
			(value) => value.authentication.kind === "header",
		)) {
			const auth = scenario.authentication
			if (auth.kind !== "header") continue
			assert.strictEqual(
				(await app.rpc("/mcp/" + scenario.id, "server/discover")).status,
				401,
			)
			const client = await app.connect(scenario.id, { [auth.name]: auth.value })
			try {
				assert.strictEqual(
					(
						await client.callTool({
							name: "echo",
							arguments: { text: "authorized" },
						})
					).isError,
					undefined,
				)
			} finally {
				await client.close()
			}
		}
	} finally {
		await app.dispose()
	}
})

it("OAuth checks code binding, consent denial, refresh rotation, scope, audience, account isolation and revocation", async () => {
	const app = await fixture()
	try {
		const denied = await app.authorize({ decision: "deny" })
		assert.strictEqual(
			denied.callback.searchParams.get("error"),
			"access_denied",
		)
		const alice = await app.authorize()
		assert.strictEqual(
			(
				await app.form("/oauth/preregistered/token", {
					...alice.body,
					code_verifier: "x".repeat(64),
				})
			).status,
			400,
		)
		const response = await alice.exchange()
		assert.strictEqual(response.status, 200, await response.clone().text())
		const token = Schema.decodeUnknownSync(Token)(await response.json())
		assert.strictEqual((await alice.exchange()).status, 400)
		assert.strictEqual(
			(
				await app.rpc(
					"/mcp/oauth-cimd",
					"server/discover",
					{},
					token.access_token,
				)
			).status,
			401,
		)
		const client = await app.connect("oauth-preregistered", {
			authorization: "Bearer " + token.access_token,
		})
		try {
			await client.callTool({
				name: "write_note",
				arguments: {
					workspace: "private",
					text: "Alice only",
					idempotencyKey: "alice",
				},
			})
		} finally {
			await client.close()
		}
		const bob = await app.authorize({ account: "bob" })
		const bobToken = Schema.decodeUnknownSync(Token)(
			await (await bob.exchange()).json(),
		)
		const bobClient = await app.connect("oauth-preregistered", {
			authorization: "Bearer " + bobToken.access_token,
		})
		try {
			const data = (
				await bobClient.callTool({
					name: "read_workspace",
					arguments: { workspace: "private" },
				})
			).structuredContent
			assert.deepStrictEqual(
				Schema.decodeUnknownSync(
					Schema.Struct({ notes: Schema.Array(Schema.Unknown) }),
				)(data).notes,
				[],
			)
		} finally {
			await bobClient.close()
		}
		const readOnly = await app.authorize({ scope: "test:read" })
		const readToken = Schema.decodeUnknownSync(Token)(
			await (await readOnly.exchange()).json(),
		)
		const readClient = await app.connect("oauth-preregistered", {
			authorization: "Bearer " + readToken.access_token,
		})
		try {
			assert.ok(
				!(await readClient.listTools()).tools.some(
					(tool) => tool.name === "write_note",
				),
			)
		} finally {
			await readClient.close()
		}
		const insufficient = await app.rpc(
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
			insufficient.headers.get("www-authenticate") ?? "",
			/test:write/,
		)
		const refreshForm = {
			grant_type: "refresh_token",
			client_id: alice.client,
			resource: alice.resource,
			refresh_token: token.refresh_token ?? "",
		}
		const refreshed = await app.form("/oauth/preregistered/token", refreshForm)
		assert.strictEqual(refreshed.status, 200)
		const next = Schema.decodeUnknownSync(Token)(await refreshed.json())
		assert.strictEqual(
			(await app.form("/oauth/preregistered/token", refreshForm)).status,
			400,
		)
		assert.strictEqual(
			(
				await app.form("/oauth/preregistered/revoke", {
					client_id: alice.client,
					token: next.access_token,
				})
			).status,
			200,
		)
		assert.strictEqual(
			(
				await app.rpc(
					"/mcp/oauth-preregistered",
					"server/discover",
					{},
					token.access_token,
				)
			).status,
			401,
		)
		assert.strictEqual(
			(
				await app.rpc(
					"/mcp/oauth-preregistered",
					"server/discover",
					{},
					next.access_token,
				)
			).status,
			401,
		)
	} finally {
		await app.dispose()
	}
})

it("CIMD, dynamic registration, confidential Basic/POST and client credentials are real token flows", async () => {
	const app = await fixture()
	try {
		const cimd = await app.authorize({
			mode: "cimd",
			client: "https://client.example/client.json",
		})
		assert.strictEqual((await cimd.exchange()).status, 200)
		const registration = await app.request("/oauth/dcr/register", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_name: "Independent dynamic host",
				redirect_uris: [origin + "/callback"],
				token_endpoint_auth_method: "none",
			}),
		})
		assert.strictEqual(registration.status, 201)
		const data = await object(registration)
		assert.strictEqual(typeof data["client_id"], "string")
		const dynamic = await app.authorize({
			mode: "dcr",
			client: String(data["client_id"]),
		})
		assert.strictEqual((await dynamic.exchange()).status, 200)
		for (const method of ["basic", "post"]) {
			const grant = await app.authorize({
				client: "protocol-test-confidential-" + method,
				secretMethod: method,
			})
			assert.strictEqual((await grant.exchange()).status, 200)
		}
		const machine = await app.form("/oauth/client-credentials/token", {
			grant_type: "client_credentials",
			client_id: "protocol-test-confidential-post",
			client_secret: "protocol-test-client-secret",
			resource: origin + "/mcp/oauth-client-credentials",
			scope: "test:read",
		})
		assert.strictEqual(machine.status, 200)
		assert.strictEqual((await object(machine))["refresh_token"], undefined)
		assert.strictEqual(
			(
				await app.form("/oauth/client-credentials/token", {
					grant_type: "client_credentials",
					client_id: "protocol-test-public",
					resource: origin + "/mcp/oauth-client-credentials",
				})
			).status,
			400,
		)
		assert.strictEqual(
			(
				await app.form("/oauth/client-credentials/token", {
					grant_type: "client_credentials",
					client_id: "protocol-test-confidential-post",
					client_secret: "wrong",
					resource: origin + "/mcp/oauth-client-credentials",
				})
			).status,
			401,
		)
	} finally {
		await app.dispose()
	}
})

it("standard keyed inputs resume form, URL, sampling and roots operations and reject replay", async () => {
	const app = await fixture()
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
	try {
		const responses: Readonly<Record<string, Schema.JsonObject>> = {
			form: { action: "accept", content: { label: "Synthetic label" } },
			url: { action: "accept" },
			sampling: {
				model: "synthetic-model",
				role: "assistant",
				content: { type: "text", text: "Synthetic response" },
			},
			roots: { roots: [{ uri: "file:///synthetic", name: "Synthetic root" }] },
		}
		for (const [kind, input] of Object.entries(responses)) {
			const original = {
				name: "request_" + kind,
				arguments: { text: "Synthetic request" },
				_meta: meta,
			}
			const started = await object(
				await app.rpc("/mcp/anonymous", "tools/call", original),
			)
			const pending = Schema.decodeUnknownSync(
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
			const wrong = await object(
				await app.rpc("/mcp/anonymous", "tools/call", {
					...resumed,
					arguments: { text: "Changed request" },
				}),
			)
			assert.ok(wrong["error"], JSON.stringify(wrong))
			const completed = await object(
				await app.rpc("/mcp/anonymous", "tools/call", resumed),
			)
			assert.ok(completed["result"], JSON.stringify(completed))
			const replayed = await object(
				await app.rpc("/mcp/anonymous", "tools/call", resumed),
			)
			assert.ok(replayed["error"], JSON.stringify(replayed))
		}
	} finally {
		await app.dispose()
	}
})

it(
	"subscriptions, progress, logs and cancellation use the selected MCP transport",
	{ timeout: 10000 },
	async () => {
		const app = await fixture()
		const client = await app.connect()
		let progress = 0
		let logs = 0
		let changed = 0
		let updated = 0
		const resourceUpdate = Promise.withResolvers<void>()
		client.setNotificationHandler("notifications/message", () => {
			logs++
		})
		client.setNotificationHandler("notifications/tools/list_changed", () => {
			changed++
		})
		client.setNotificationHandler("notifications/resources/updated", () => {
			updated++
			resourceUpdate.resolve()
		})
		const subscription = await client.listen({
			toolsListChanged: true,
			resourceSubscriptions: ["protocol-test://workspace/subscribed"],
		})
		try {
			await client.callTool(
				{
					name: "wait",
					arguments: { milliseconds: 10 },
					_meta: { "io.modelcontextprotocol/logLevel": "info" },
				},
				{
					onprogress: () => {
						progress++
					},
				},
			)
			assert.strictEqual(progress, 5)
			assert.ok(logs > 0)
			await client.callTool({ name: "notify", arguments: {} })
			await client.callTool({
				name: "write_note",
				arguments: {
					workspace: "subscribed",
					text: "Subscription fixture",
					idempotencyKey: "first",
				},
			})
			assert.ok(changed > 0)
			await resourceUpdate.promise
			assert.ok(updated > 0)
			const controller = new AbortController()
			await expect(
				client.callTool(
					{ name: "wait", arguments: { milliseconds: 10000 } },
					{ signal: controller.signal, onprogress: () => controller.abort() },
				),
			).rejects.toThrow()
			assert.deepStrictEqual(
				(
					await client.callTool({
						name: "echo",
						arguments: { text: "still usable" },
					})
				).structuredContent,
				{ scenario: "anonymous", text: "still usable" },
			)
		} finally {
			await subscription.close()
			await client.close()
			await app.dispose()
		}
	},
)

it("a controlled clock makes codes, access tokens, refresh grants and workspaces expire", async () => {
	let now = Date.now()
	const live = Clock.Clock.defaultValue()
	const clock: Clock.Clock = {
		currentTimeMillis: Effect.sync(() => now),
		currentTimeMillisUnsafe: () => now,
		currentTimeNanos: live.currentTimeNanos,
		currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
		monotonicTimeNanos: live.monotonicTimeNanos,
		monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
		sleep: (duration) => live.sleep(duration),
	}
	const app = await fixture(clock)
	try {
		const expiredCode = await app.authorize()
		now += 60_001
		assert.strictEqual((await expiredCode.exchange()).status, 400)
		const grant = await app.authorize()
		const tokens = Schema.decodeUnknownSync(Token)(
			await (await grant.exchange()).json(),
		)
		const client = await app.connect()
		try {
			await client.callTool({
				name: "write_note",
				arguments: {
					workspace: "expires",
					text: "Temporary",
					idempotencyKey: "first",
				},
			})
			now += 300_001
			assert.strictEqual(
				(
					await app.rpc(
						"/mcp/oauth-preregistered",
						"server/discover",
						{},
						tokens.access_token,
					)
				).status,
				401,
			)
			assert.strictEqual(
				(
					await app.form("/oauth/preregistered/token", {
						client_id: grant.client,
						resource: grant.resource,
						grant_type: "refresh_token",
						refresh_token: tokens.refresh_token ?? "",
					})
				).status,
				200,
			)
			now += 1_800_001
			const view = (
				await client.callTool({
					name: "read_workspace",
					arguments: { workspace: "expires" },
				})
			).structuredContent
			assert.deepStrictEqual(
				Schema.decodeUnknownSync(
					Schema.Struct({ notes: Schema.Array(Schema.Unknown) }),
				)(view).notes,
				[],
			)
			now += 3_600_001
			assert.strictEqual(
				(
					await app.form("/oauth/preregistered/token", {
						client_id: grant.client,
						resource: grant.resource,
						grant_type: "refresh_token",
						refresh_token: tokens.refresh_token ?? "",
					})
				).status,
				400,
			)
		} finally {
			await client.close()
		}
	} finally {
		await app.dispose()
	}
})

it("protocol discovery and anonymous public indexing read the published fixtures", async () => {
	const app = await fixture()
	const readDocument: Network.PublicNetwork["Service"]["readDocument"] = (
		input,
	) =>
		Effect.tryPromise({
			try: async () => {
				const response = await app.handler(
					new Request(input.url, {
						headers: {
							...(input.validators?.etag === undefined
								? {}
								: { "if-none-match": input.validators.etag }),
						},
					}),
				)
				return {
					url: input.url,
					status: response.status,
					headers: Object.fromEntries(response.headers),
					text: await response.text(),
				}
			},
			catch: () =>
				Network.NetworkError.make({
					reason: "Transport",
					message: "Fixture document request failed.",
				}),
		})
	const publicNetwork = Layer.succeed(Network.PublicNetwork, { readDocument })
	const network = Layer.succeed(Network.Network, {
		identity: { owner: "discovery-test", scope: "public" },
		readDocument: (input) => readDocument(input),
		execute: () =>
			Effect.die(new Error("Discovery must not send business requests")),
	})
	const rules = CatalogDiscovery.layerRules
	try {
		const discovery = CatalogDiscovery.layer().pipe(
			Layer.provide(network),
			Layer.provide(rules),
		)

		const indexing = PublicIndexing.layer.pipe(
			Layer.provide(RobotsPolicy.layer),
			Layer.provideMerge(Layer.merge(publicNetwork, MemoryIndex.layer)),
			Layer.provide(rules),
		)
		await using runtime = ManagedRuntime.make(Layer.merge(discovery, indexing))
		const selected = await runtime.runPromise(
			Discovery.resolve(origin + "/apps/anonymous"),
		)
		assert.strictEqual(selected._tag, "Single")
		const domain = await runtime.runPromise(
			Discovery.resolve("protocol-test.example.com"),
		)
		assert.strictEqual(domain._tag, "Multiple")

		await runtime.runPromise(
			Effect.gen(function* () {
				assert.strictEqual(
					(yield* Indexing.sync({
						cardUrl: origin + "/apps/anonymous/server-card.json",
					}))._tag,
					"Indexed",
				)
				assert.strictEqual(
					(yield* Indexing.sync({
						cardUrl: origin + "/fixtures/noindex/server-card.json",
					}))._tag,
					"Excluded",
				)
				assert.strictEqual(
					(yield* Indexing.sync({
						cardUrl: origin + "/fixtures/robots-denied/server-card.json",
					}))._tag,
					"Excluded",
				)
				assert.strictEqual(
					(yield* Indexing.sync({
						cardUrl: origin + "/fixtures/unlisted/server-card.json",
					}))._tag,
					"Excluded",
				)
			}),
		)
	} finally {
		await app.dispose()
	}
})
