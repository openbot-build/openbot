import { Array as EffectArray, Effect, Layer, Schema } from "effect"
import { McpPublisher, Document, Publisher } from "@openbot-build/protocol"
import { assert, it } from "@effect/vitest"
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"

import { McpServer, Tool, Toolkit } from "effect/ai"
import { HttpRouter } from "effect/http"

const origin = "https://service.example"
const card: Document.ServerCard = {
	$schema: Document.cardSchemaUrl,
	name: "example.test/notes",
	version: "1.0.0",
	description: "Create notes",
	remotes: [
		{
			type: "streamable-http" as const,
			url: origin + "/mcp",
			supportedProtocolVersions: [Document.protocolVersion],
		},
	],
	_meta: { "example.test/extension": { preserved: true } },
}
const publication: Publisher.Publication = {
	card,
	cardUrl: origin + "/mcp/server-card",
	catalogUrl: origin + "/.well-known/ai-catalog.json",
	mcpUrl: origin + "/mcp",
	etag: '"notes-v1"',
	lastModified: "Fri, 09 Oct 2026 00:00:00 GMT",
	noindex: true,
	allowedOrigins: ["https://host.example"],
}

it.effect(
	"Card and Catalog keep format, compatibility and URL identity separate",
	() =>
		Effect.gen(function* () {
			const decoded = yield* Document.ServerCard.decode(card)
			assert.deepStrictEqual(decoded._meta, card._meta)
			assert.strictEqual((yield* Document.compatibleRemotes(decoded)).length, 1)
			assert.match(
				String(
					yield* Effect.flip(
						Document.ServerCard.decode({
							...card,
							name: "no-namespace",
						}),
					),
				),
				/InvalidDocument/,
			)
			assert.match(
				String(
					yield* Effect.flip(
						Document.Catalog.decode({
							specVersion: "1.0",
							entries: [
								{
									identifier: "x",
									type: "x",
									url: origin,
									data: {},
								},
							],
						}),
					),
				),
				/InvalidDocument/,
			)
			assert.match(
				String(
					yield* Effect.flip(
						Document.compatibleRemotes({ ...decoded, remotes: [] }),
					),
				),
				/IncompatibleCard/,
			)
			assert.match(
				String(
					yield* Effect.flip(
						McpPublisher.validate({
							...publication,
							mcpUrl: "http://service.example/mcp",
						}),
					),
				),
				/SchemaError/,
			)
			assert.match(
				String(
					yield* Effect.flip(
						Schema.decodeEffect(Document.Link)(
							"https://token:secret@service.example/",
						),
					),
				),
				/SchemaError/,
			)
			assert.strictEqual(
				yield* Schema.decodeEffect(Document.Link)(
					"https://SERVICE.example:443/cards/a?b=2&a=1#fragment",
				),
				"https://service.example/cards/a?b=2&a=1",
			)
			const identity = "https://service.example/cards/a?b=2&a=1"
			assert.strictEqual(
				yield* Schema.encodeEffect(Document.Link)(identity),
				identity,
			)
			assert.strictEqual(
				yield* Schema.encodeEffect(Document.Link)(identity + "#fragment"),
				identity,
			)
			for (const input of [
				"/relative",
				"not a URL",
				"http://service.example",
				42,
			]) {
				assert.throws(
					() => Schema.decodeUnknownSync(Document.Link)(input),
					Schema.SchemaError,
				)
			}
			for (const input of [
				"not a URL",
				"http://service.example",
				"https://token:secret@service.example/",
			]) {
				assert.throws(
					() => Schema.encodeSync(Document.Link)(input),
					Schema.SchemaError,
				)
			}
		}),
)

it("Independent SDK client calls the Effect publisher and reads native UI resources", async () => {
	let calls = 0
	const tool = Tool.make("CreateNote", {
		parameters: Schema.Struct({ text: Schema.String }),
		success: Schema.Struct({
			id: Schema.String,
			text: Schema.String,
		}),
	}).annotate(Tool.Meta, {
		ui: {
			resourceUri: "ui://notes/main.html",
			visibility: ["model", "app"],
		},
	})
	const tools = Toolkit.make(tool)
	const handlers = tools.toLayer({
		CreateNote: ({ text }) =>
			Effect.sync(() => ({ id: String(++calls), text })),
	})
	const register = Effect.gen(function* () {
		// Registration builds the publisher business handlers in its Scope.
		const services = yield* Layer.build(handlers)
		yield* McpServer.registerToolkit(tools).pipe(
			Effect.provideContext(services),
		)
		yield* McpPublisher.registerUi({
			uri: "ui://notes/main.html",
			name: "Notes",
			html: "<!doctype html><p>Notes</p>",
			meta: { ui: { csp: { connectDomains: [] } } },
		})
		yield* McpServer.registerResource({
			uri: "notes://latest",
			name: "Latest",
			content: Effect.succeed("Latest note"),
		})
		yield* McpServer.registerPrompt({
			name: "Summarize",
			content: () => Effect.succeed("Summarize notes"),
		})
	})
	const app = HttpRouter.toWebHandler(
		McpPublisher.layer({ publication, register }),
		{ disableLogger: true },
	)
	let requests: ReadonlyArray<{
		method: string
		headers: Headers
		json: unknown
	}> = []
	const client = new Client(
		{ name: "independent-standard-client", version: "1.0.0" },
		{
			versionNegotiation: {
				mode: { pin: Document.protocolVersion },
			},
			inputRequired: { autoFulfill: false },
		},
	)
	try {
		const cardResponse = await app.handler(new Request(publication.cardUrl))
		assert.strictEqual(
			cardResponse.headers.get("content-type"),
			Document.cardMediaType,
		)
		assert.strictEqual(cardResponse.headers.get("x-robots-tag"), "noindex")
		assert.deepStrictEqual(await cardResponse.json(), card)
		const cached = await app.handler(
			new Request(publication.cardUrl, {
				headers: { "if-none-match": 'W/"notes-v1"' },
			}),
		)
		assert.strictEqual(cached.status, 304)
		assert.strictEqual(await cached.text(), "")
		const catalogResponse = await app.handler(
			new Request(publication.catalogUrl),
		)
		assert.strictEqual(
			catalogResponse.headers.get("content-type"),
			Document.catalogMediaType,
		)
		const catalog = await Effect.runPromise(
			Document.Catalog.decode(await catalogResponse.json()),
		)
		assert.strictEqual(catalog.entries[0]?.url, publication.cardUrl)
		assert.match(
			await Effect.runPromise(
				McpPublisher.catalogLinkHtml(publication.catalogUrl),
			),
			/rel="ai-catalog"/,
		)
		await client.connect(
			new StreamableHTTPClientTransport(new URL(publication.mcpUrl), {
				fetch: async (url, init) => {
					const request = new Request(url, init)
					requests = EffectArray.append(requests, {
						method: request.method,
						headers: request.headers,
						json: await request.clone().json(),
					})
					return app.handler(request)
				},
			}),
		)
		const listed = (await client.listTools()).tools
		assert.strictEqual(listed[0]?.name, "CreateNote")
		assert.deepStrictEqual(listed[0]?._meta?.["ui"], {
			resourceUri: "ui://notes/main.html",
			visibility: ["model", "app"],
		})
		const result = await client.callTool({
			name: "CreateNote",
			arguments: { text: "hello" },
		})
		assert.deepStrictEqual(result.structuredContent, {
			id: "1",
			text: "hello",
		})
		assert.ok(
			result.content.some((c) => c.type === "text" && c.text.includes("hello")),
		)
		const resource = await client.readResource({
			uri: "ui://notes/main.html",
		})
		assert.strictEqual(resource.contents[0]?.mimeType, Document.uiMediaType)
		assert.deepStrictEqual(resource.contents[0]?._meta?.["ui"], {
			csp: { connectDomains: [] },
		})
		assert.strictEqual((await client.listResources()).resources.length, 2)
		assert.strictEqual(
			(await client.listPrompts()).prompts[0]?.name,
			"Summarize",
		)
		assert.strictEqual(
			(await client.getPrompt({ name: "Summarize" })).messages[0]?.content.type,
			"text",
		)
		const bodies = requests.map((r) =>
			Schema.decodeUnknownSync(Schema.Struct({ method: Schema.String }))(
				r.json,
			),
		)
		assert.strictEqual(bodies[0]?.method, "server/discover")
		assert.ok(bodies.every((r) => r.method !== "initialize"))
		assert.ok(
			requests.every(
				(r) => r.method === "POST" && !r.headers.has("mcp-session-id"),
			),
		)
		const call = requests[bodies.findIndex((r) => r.method === "tools/call")]
		assert.ok(call)
		assert.strictEqual(
			call.headers.get("mcp-protocol-version"),
			Document.protocolVersion,
		)
		assert.strictEqual(call.headers.get("mcp-method"), "tools/call")
		const rejected = await app.handler(
			new Request(publication.mcpUrl, {
				method: "POST",
				headers: {
					origin: "https://attacker.example",
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify(call.json),
			}),
		)
		assert.strictEqual(rejected.status, 403)
		assert.strictEqual(calls, 1)
	} finally {
		await client.close()
		await app.dispose()
	}
})

it("Generic entry imports without a DOM, and building a Layer does no I/O", async () => {
	assert.strictEqual(typeof globalThis.document, "undefined")
	assert.ok((await import("@openbot-build/protocol")).McpPublisher.layer)
	assert.ok(
		Layer.isLayer(McpPublisher.layer({ publication, register: Effect.void })),
	)
})
