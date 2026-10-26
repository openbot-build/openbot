import {
	Array as Arr,
	Effect,
	FiberSet,
	Layer,
	Option,
	Ref,
	Schema,
	String as Str,
} from "effect"
import { McpPublisher, Document, Publisher } from "@openbot-build/protocol"
import { assert, it } from "@effect/vitest"
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"

import { McpServer, Tool, Toolkit } from "effect/ai"
import {
	FetchHttpClient,
	Headers,
	HttpClient,
	HttpClientRequest,
	HttpEffect,
	HttpRouter,
} from "effect/http"

const origin = "https://service.example"
const card = Document.ServerCard.make({
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
})
const publication = Publisher.Publication.make({
	card,
	cardUrl: origin + "/mcp/server-card",
	catalogUrl: origin + "/.well-known/ai-catalog.json",
	mcpUrl: origin + "/mcp",
	etag: '"notes-v1"',
	lastModified: "Fri, 09 Oct 2026 00:00:00 GMT",
	noindex: true,
	allowedOrigins: ["https://host.example"],
})

it.effect(
	"Card and Catalog keep format, compatibility and URL identity separate",
	() =>
		Effect.gen(function* () {
			const decoded = yield* Document.ServerCard.decode(card)
			assert.deepStrictEqual(decoded._meta, card._meta)
			assert.strictEqual((yield* Document.compatibleRemotes(decoded)).length, 1)
			const badCard = yield* Effect.flip(
				Document.ServerCard.decode({ ...card, name: "no-namespace" }),
			)
			assert.strictEqual(badCard._tag, "InvalidDocument")
			assert.strictEqual(badCard.kind, "Card")
			const badCatalog = yield* Effect.flip(
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
			)
			assert.strictEqual(badCatalog._tag, "InvalidDocument")
			assert.strictEqual(badCatalog.kind, "Catalog")
			assert.strictEqual(
				(yield* Effect.flip(
					Document.compatibleRemotes({ ...decoded, remotes: [] }),
				))._tag,
				"IncompatibleCard",
			)
			assert.instanceOf(
				yield* Effect.flip(
					McpPublisher.validate({
						...publication,
						mcpUrl: "http://service.example/mcp",
					}),
				),
				Schema.SchemaError,
			)
			assert.instanceOf(
				yield* Effect.flip(
					Schema.decodeEffect(Document.Link)(
						"https://token:secret@service.example/",
					),
				),
				Schema.SchemaError,
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
				assert.instanceOf(
					yield* Effect.flip(Schema.decodeUnknownEffect(Document.Link)(input)),
					Schema.SchemaError,
				)
			}
			for (const input of [
				"not a URL",
				"http://service.example",
				"https://token:secret@service.example/",
			]) {
				assert.instanceOf(
					yield* Effect.flip(Schema.encodeEffect(Document.Link)(input)),
					Schema.SchemaError,
				)
			}
		}),
)

/** The JSON-RPC method of an MCP request body. */
const RpcMethod = Schema.fromJsonString(
	Schema.Struct({ method: Schema.String }),
)

it.layer(FetchHttpClient.layer)((it) => {
	it.effect(
		"Independent SDK client calls the Effect publisher and reads native UI resources",
		() =>
			Effect.gen(function* () {
				const calls = yield* Ref.make(0)
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
						Ref.updateAndGet(calls, (count) => count + 1).pipe(
							Effect.map((count) => ({ id: String(count), text })),
						),
				})
				const register = Effect.gen(function* () {
					// Registration builds the publisher business handlers in its Scope.
					const services = yield* Layer.build(handlers)
					yield* McpServer.registerToolkit(tools).pipe(
						Effect.provideContext(services),
					)
					yield* McpPublisher.registerUi(
						Publisher.UiResource.make({
							uri: "ui://notes/main.html",
							name: "Notes",
							html: "<!doctype html><p>Notes</p>",
							meta: { ui: { csp: { connectDomains: [] } } },
						}),
					)
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
				// The publisher layer lives in the Scope of the test.
				const publisher = HttpEffect.toWebHandler(
					yield* HttpRouter.toHttpEffect(
						McpPublisher.layer({ publication, register }),
					),
				)
				const http = (yield* HttpClient.HttpClient).pipe(
					HttpClient.transformResponse(
						Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
							publisher(new Request(input, init)),
						),
					),
				)
				const requests = yield* Ref.make<
					ReadonlyArray<{
						readonly method: string
						readonly headers: Headers.Headers
						readonly body: string
					}>
				>([])
				// The SDK transport needs a fetch function that gives a Promise.
				const runPromise = yield* FiberSet.makeRuntimePromise()
				const client = yield* Effect.acquireRelease(
					Effect.sync(
						() =>
							new Client(
								{ name: "independent-standard-client", version: "1.0.0" },
								{
									versionNegotiation: {
										mode: { pin: Document.protocolVersion },
									},
									inputRequired: { autoFulfill: false },
								},
							),
					),
					(client) => Effect.promise(() => client.close()),
				)
				const cardResponse = yield* http.get(publication.cardUrl)
				assert.strictEqual(
					cardResponse.headers["content-type"],
					Document.cardMediaType,
				)
				assert.strictEqual(cardResponse.headers["x-robots-tag"], "noindex")
				assert.deepStrictEqual<unknown>(yield* cardResponse.json, card)
				const cached = yield* http.get(publication.cardUrl, {
					headers: { "if-none-match": 'W/"notes-v1"' },
				})
				assert.strictEqual(cached.status, 304)
				assert.strictEqual(yield* cached.text, "")
				const catalogResponse = yield* http.get(publication.catalogUrl)
				assert.strictEqual(
					catalogResponse.headers["content-type"],
					Document.catalogMediaType,
				)
				const catalog = yield* Document.Catalog.decode(
					yield* catalogResponse.json,
				)
				assert.strictEqual(catalog.entries[0]?.url, publication.cardUrl)
				assert.match(
					yield* McpPublisher.catalogLinkHtml(publication.catalogUrl),
					/rel="ai-catalog"/,
				)
				yield* Effect.promise(() =>
					client.connect(
						new StreamableHTTPClientTransport(new URL(publication.mcpUrl), {
							fetch: (input, init) =>
								runPromise(
									Effect.gen(function* () {
										const request = new Request(input, init)
										const body = yield* Effect.promise(() =>
											request.clone().text(),
										)
										yield* Ref.update(
											requests,
											Arr.append({
												method: request.method,
												headers: Headers.fromInput(request.headers),
												body,
											}),
										)
										return yield* Effect.promise(() => publisher(request))
									}),
								),
						}),
					),
				)
				const listed = (yield* Effect.promise(() => client.listTools())).tools
				assert.strictEqual(listed[0]?.name, "CreateNote")
				assert.deepStrictEqual(listed[0]?._meta?.["ui"], {
					resourceUri: "ui://notes/main.html",
					visibility: ["model", "app"],
				})
				const result = yield* Effect.promise(() =>
					client.callTool({
						name: "CreateNote",
						arguments: { text: "hello" },
					}),
				)
				assert.deepStrictEqual(result.structuredContent, {
					id: "1",
					text: "hello",
				})
				assert.ok(
					Arr.some(
						result.content,
						(c) => c.type === "text" && Str.includes("hello")(c.text),
					),
				)
				const resource = yield* Effect.promise(() =>
					client.readResource({
						uri: "ui://notes/main.html",
					}),
				)
				assert.strictEqual(resource.contents[0]?.mimeType, Document.uiMediaType)
				assert.deepStrictEqual(resource.contents[0]?._meta?.["ui"], {
					csp: { connectDomains: [] },
				})
				assert.strictEqual(
					(yield* Effect.promise(() => client.listResources())).resources
						.length,
					2,
				)
				assert.strictEqual(
					(yield* Effect.promise(() => client.listPrompts())).prompts[0]?.name,
					"Summarize",
				)
				assert.strictEqual(
					(yield* Effect.promise(() => client.getPrompt({ name: "Summarize" })))
						.messages[0]?.content.type,
					"text",
				)
				const sent = yield* Ref.get(requests)
				const bodies = yield* Effect.forEach(sent, (request) =>
					Schema.decodeEffect(RpcMethod)(request.body),
				)
				assert.strictEqual(bodies[0]?.method, "server/discover")
				assert.ok(Arr.every(bodies, (body) => body.method !== "initialize"))
				assert.ok(
					Arr.every(
						sent,
						(request) =>
							request.method === "POST" &&
							!Headers.has(request.headers, "mcp-session-id"),
					),
				)
				const call = yield* Arr.findFirstIndex(
					bodies,
					(body) => body.method === "tools/call",
				).pipe(
					Option.flatMap((index) => Arr.get(sent, index)),
					Effect.fromOption,
				)
				assert.strictEqual(
					call.headers["mcp-protocol-version"],
					Document.protocolVersion,
				)
				assert.strictEqual(call.headers["mcp-method"], "tools/call")
				const rejected = yield* http.execute(
					HttpClientRequest.post(publication.mcpUrl).pipe(
						HttpClientRequest.setHeaders({
							origin: "https://attacker.example",
							accept: "application/json, text/event-stream",
						}),
						HttpClientRequest.bodyText(call.body, "application/json"),
					),
				)
				assert.strictEqual(rejected.status, 403)
				assert.strictEqual(yield* Ref.get(calls), 1)
			}),
	)
})

it.effect(
	"Generic entry imports without a DOM, and building a Layer does no I/O",
	() =>
		Effect.gen(function* () {
			assert.strictEqual(typeof globalThis.document, "undefined")
			assert.ok(
				(yield* Effect.promise(() => import("@openbot-build/protocol")))
					.McpPublisher.layer,
			)
			const registered = yield* Ref.make(false)
			const layer = McpPublisher.layer({
				publication,
				register: Ref.set(registered, true),
			})
			assert.ok(Layer.isLayer(layer))
			assert.isFalse(yield* Ref.get(registered))
		}),
)
