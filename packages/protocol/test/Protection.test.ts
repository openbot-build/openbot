import { Array as Arr, Clock, Effect, Layer, Redacted, Schema } from "effect"
import {
	PublisherProtection,
	McpPublisher,
	Authorization,
	Document,
	Protection,
	Publisher,
} from "@openbot-build/protocol"
import { assert, it } from "@effect/vitest"
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"

import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai"
import { HttpRouter } from "effect/http"

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

it.effect(
	"Protected publisher checks real identity, scopes and audience before it filters lists or runs tools",
	() =>
		Effect.gen(function* () {
			const origin = "https://notes.example"
			const resource = origin + "/mcp"
			const issuer = "https://accounts.example"
			let calls = 0
			const tools = Toolkit.make(
				...Arr.map(["AliceNote", "BobNote"], (name) =>
					Tool.make(name, {
						parameters: Tool.EmptyParams,
						success: Schema.Struct({
							subject: Schema.String,
						}),
						dependencies: [McpSchema.McpRequestContext],
					}),
				),
			)
			const handlers = tools.toLayer({
				AliceNote: () =>
					PublisherProtection.currentIdentity.pipe(
						Effect.orDie,
						Effect.map((identity) => {
							calls++
							return { subject: identity.subject }
						}),
					),
				BobNote: () =>
					PublisherProtection.currentIdentity.pipe(
						Effect.orDie,
						Effect.map((identity) => {
							calls++
							return { subject: identity.subject }
						}),
					),
			})
			const registration = Effect.gen(function* () {
				const services = yield* Layer.build(handlers)
				yield* McpServer.registerToolkit(tools).pipe(
					Effect.provideContext(services),
				)
			})
			// The verifier reads the clock of the publisher runtime, which also checks
			// the expiry time.
			const verification = Layer.succeed(Protection.TokenVerifier, {
				verify: (token) =>
					Effect.gen(function* () {
						const value = Redacted.value(token)
						if (
							!Arr.contains(
								["alice", "bob", "expired", "audience", "scope"],
								value,
							)
						)
							return yield* Protection.TokenRejected.make({
								reason: "Invalid",
							})
						const now = yield* Clock.currentTimeMillis
						return Protection.Identity.make({
							subject: value,
							issuer,
							audiences: [value === "audience" ? origin + "/other" : resource],
							expiresAt: value === "expired" ? 1 : now + 60000,
							scopes: value === "scope" ? [] : ["notes"],
						})
					}),
			})
			const policy = Layer.succeed(Protection.AccessPolicy, {
				check: (identity, operation) =>
					operation.method !== "tools/call" ||
					operation.target ===
						(identity.subject === "alice" ? "AliceNote" : "BobNote")
						? Effect.void
						: Effect.fail(
								Protection.AccessDenied.make({
									scopes: ["account:other"],
								}),
							),
				visible: (identity, operation) =>
					Effect.succeed(
						operation.target ===
							(identity.subject === "alice" ? "AliceNote" : "BobNote"),
					),
			})
			const layer = McpPublisher.layerProtected({
				publication: Publisher.Publication.make({
					cardUrl: origin + "/card",
					catalogUrl: origin + "/.well-known/ai-catalog.json",
					mcpUrl: resource,
					card: {
						$schema: Document.cardSchemaUrl,
						name: "example.test/notes",
						description: "Protected notes",
						version: "1.0.0",
						remotes: [
							{
								type: "streamable-http",
								url: resource,
								supportedProtocolVersions: [Document.protocolVersion],
							},
						],
					},
				}),
				protection: {
					metadataUrl: origin + "/.well-known/oauth-protected-resource/mcp",
					authorizationServers: [issuer],
					scopes: ["notes"],
				},
				register: registration,
			})
			const app = yield* Effect.acquireRelease(
				Effect.sync(() =>
					HttpRouter.toWebHandler(
						layer.pipe(Layer.provide(Layer.merge(verification, policy))),
						{ disableLogger: true },
					),
				),
				(app) => Effect.promise(() => app.dispose()),
			)
			// The web handler runs in memory and gives every failure as a response, so
			// a rejected Promise is a defect.
			const handle = (request: Request) =>
				Effect.promise(() => app.handler(request))
			const call = (token: string, id: number, name: string) =>
				Effect.gen(function* () {
					return yield* handle(
						new Request(resource, {
							method: "POST",
							headers: {
								...(token === ""
									? {}
									: {
											authorization: "Bearer " + token,
										}),
								"content-type": "application/json",
								accept: "application/json, text/event-stream",
							},
							body: yield* encodeJson({
								jsonrpc: "2.0",
								id,
								method: "tools/call",
								params: {
									name,
									arguments: {},
								},
							}),
						}),
					)
				})
			const verifierRequired: Protection.TokenVerifier extends Layer.Services<
				typeof layer
			>
				? true
				: false = true
			assert.ok(verifierRequired)
			assert.strictEqual(
				(yield* handle(new Request(origin + "/card"))).status,
				200,
			)
			const prm = yield* handle(
				new Request(origin + "/.well-known/oauth-protected-resource/mcp"),
			)
			assert.strictEqual(
				(yield* Authorization.ResourceMetadata.decode(
					yield* Effect.promise(() => prm.json()),
				)).resource,
				resource,
			)
			for (const token of ["", "invalid", "expired", "audience", "scope"]) {
				const response = yield* call(token, 1, "AliceNote")
				assert.strictEqual(response.status, token === "scope" ? 403 : 401)
				assert.match(
					response.headers.get("www-authenticate") ?? "",
					/resource_metadata=/,
				)
			}
			assert.strictEqual(calls, 0)
			for (const account of ["alice", "bob"]) {
				// The client closes when the test ends, before the publisher stops.
				const client = yield* Effect.acquireRelease(
					Effect.sync(
						() =>
							new Client(
								{ name: "independent", version: "1.0.0" },
								{
									versionNegotiation: {
										mode: {
											pin: Document.protocolVersion,
										},
									},
									inputRequired: { autoFulfill: false },
								},
							),
					),
					(client) => Effect.promise(() => client.close()),
				)
				yield* Effect.promise(() =>
					client.connect(
						new StreamableHTTPClientTransport(new URL(resource), {
							requestInit: {
								headers: {
									authorization: "Bearer " + account,
								},
							},
							fetch: (input, init) => app.handler(new Request(input, init)),
						}),
					),
				)
				const list = yield* Effect.promise(() => client.listTools())
				assert.deepStrictEqual(
					Arr.map(list.tools, (tool) => tool.name),
					[account === "alice" ? "AliceNote" : "BobNote"],
				)
				assert.strictEqual(list["cacheScope"], "private")
				const result = yield* Effect.promise(() =>
					client.callTool({
						name: list.tools[0]?.name ?? "",
						arguments: {},
					}),
				)
				assert.deepStrictEqual(result.structuredContent, {
					subject: account,
				})
				const before: number = calls
				const denied = yield* call(
					account,
					3,
					account === "alice" ? "BobNote" : "AliceNote",
				)
				assert.strictEqual(denied.status, 403)
				assert.strictEqual(calls, before)
			}
			assert.strictEqual(calls, 2)
		}),
)
