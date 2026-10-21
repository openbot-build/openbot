import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Layer, Redacted, ManagedRuntime } from "effect"
import {
	AppConnections,
	Client,
	Document,
	McpClient,
	MemoryStore,
	Store,
} from "@openbot-build/protocol"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { startHttps } from "./Fixture.ts"

/** An independent 2025 MCP server with no OpenBot publication or discovery method. */
const service = async (version = "2025-11-25") => {
	const methods: string[] = []
	const state = {
		calls: 0,
		protected: false,
		malformed: false,
		clientCapabilities: undefined as Record<string, unknown> | undefined,
	}
	const fixture = await startHttps((request, response) => {
		if (request.method !== "POST") {
			response.writeHead(405).end()
			return
		}
		let body = ""
		request.setEncoding("utf8")
		request.on("data", (part: string) => {
			body += part
		})
		request.on("end", () => {
			const message = JSON.parse(body) as {
				id?: string | number
				method: string
				params?: {
					cursor?: string
					arguments?: { query?: string }
					capabilities?: Record<string, unknown>
				}
			}
			methods.push(message.method)
			if (state.protected) {
				response
					.writeHead(401, {
						"www-authenticate": `Bearer resource_metadata="${fixture.ipOrigin}/resource"`,
					})
					.end()
				return
			}
			if (message.id === undefined) {
				response.writeHead(202).end()
				return
			}
			const reply = (result: object) => {
				response.writeHead(200, { "content-type": "application/json" })
				response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
			}
			switch (message.method) {
				case "initialize":
					state.clientCapabilities = message.params?.capabilities
					reply(
						state.malformed
							? { protocolVersion: version }
							: {
									protocolVersion: version,
									serverInfo: { name: "standard-docs", version: "1.0.0" },
									capabilities: { tools: {}, resources: {}, prompts: {} },
								},
					)
					return
				case "tools/list":
					reply(
						message.params?.cursor === "second"
							? { tools: [] }
							: {
									tools: [
										{
											name: "SearchDocs",
											description: "Search public documentation",
											inputSchema: {
												type: "object",
												properties: { query: { type: "string" } },
												required: ["query"],
											},
										},
									],
									nextCursor: "second",
								},
					)
					return
				case "resources/list":
					reply({
						resources: [
							{ uri: "docs://guide", name: "Guide", mimeType: "text/plain" },
						],
					})
					return
				case "resources/templates/list":
					reply({ resourceTemplates: [] })
					return
				case "prompts/list":
					reply({ prompts: [{ name: "Explain" }] })
					return
				case "resources/read":
					reply({ contents: [{ uri: "docs://guide", text: "A real guide." }] })
					return
				case "prompts/get":
					reply({
						messages: [
							{
								role: "user",
								content: { type: "text", text: "Explain the guide." },
							},
						],
					})
					return
				case "tools/call":
					state.calls++
					reply({
						content: [
							{
								type: "text",
								text: `Found: ${message.params?.arguments?.query}`,
							},
						],
					})
					return
				default:
					response.writeHead(200, { "content-type": "application/json" })
					response.end(
						JSON.stringify({
							jsonrpc: "2.0",
							id: message.id,
							error: { code: -32601, message: "Method not found" },
						}),
					)
			}
		})
	})
	const key = { owner: "alice", connectionId: "standard-docs" }
	const endpoint = fixture.ipOrigin + "/mcp"
	const cardUrl = "urn:openbot:manual:standard-docs"
	const layers = Layer.mergeAll(
		MemoryStore.layer,
		MemoryStore.layerCredentials,
		AppConnections.layerConnectionScopes,
		McpClient.layerPolicy(() => Effect.void),
		NodeHttpServer.layerUserNetwork({
			owner: key.owner,
			allowedOrigins: [fixture.ipOrigin],
			allowAddress: (ip) => ip === "127.0.0.1",
			ca: fixture.ca,
		}),
	)
	const prepare = Store.AppStore.use((store) =>
		store.save({
			app: {
				cardUrl,
				sources: [{ role: "manual", url: endpoint }],
				card: {
					$schema: Document.cardSchemaUrl,
					name: "manual/docs",
					version: "1.0.0",
					description: "Private MCP configuration",
					remotes: [{ type: "streamable-http", url: endpoint }],
				},
			},
			connection: {
				...key,
				cardUrl,
				endpoint,
				remoteIndex: 0,
				configuration: Redacted.make({}),
				headers: Redacted.make({}),
				state: "Enabled",
				authorization: { _tag: "Unprotected" },
			},
		}),
	)
	return {
		...fixture,
		methods,
		state,
		layers,
		prepare,
		connect: (
			protocol: "standard" | "openbot" = "standard",
			options: Pick<
				Parameters<typeof McpClient.open>[0],
				"capabilities" | "inputs"
			> = {},
		) =>
			McpClient.open({
				...options,
				key,
				clientInfo: { name: "Kay", version: "1.0.0" },
				protocol,
			}),
	}
}

for (const version of ["2025-03-26", "2025-06-18", "2025-11-25"]) {
	test(`standard MCP negotiates ${version} and reads real capabilities without fabricated OpenBot discovery`, async () => {
		const fixture = await service(version)
		try {
			await using runtime = ManagedRuntime.make(fixture.layers)
			await runtime.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						yield* fixture.prepare
						const client = yield* fixture.connect()
						assert.equal(client.protocolVersion, version)
						assert.equal(client.discovery, undefined)
						assert.equal(client.serverInfo?.name, "standard-docs")
						assert.deepEqual(client.capabilities, {
							tools: {},
							resources: {},
							prompts: {},
						})
						assert.equal(fixture.state.calls, 0)
						assert.ok(fixture.methods.includes("initialize"))
						assert.ok(fixture.methods.includes("notifications/initialized"))
						assert.equal((yield* client.modelTools).length, 1)
						assert.equal(
							(yield* client.listTools({ singlePage: true })).nextCursor,
							"second",
						)
						assert.equal(
							(yield* client.listResources()).resources[0]?.uri,
							"docs://guide",
						)
						assert.equal(
							(yield* client.listPrompts()).prompts[0]?.name,
							"Explain",
						)
						const result = yield* client.callTool(
							{ name: "SearchDocs", arguments: { query: "Workers" } },
							{ source: "host", readOnly: true },
						)
						assert.equal(result._tag, "Completed")
						if (result._tag === "Completed")
							assert.deepEqual(result.result.content, [
								{ type: "text", text: "Found: Workers" },
							])
						assert.equal(
							(yield* client.readResource(
								{ uri: "docs://guide" },
								{ source: "host" },
							))._tag,
							"Completed",
						)
						assert.equal(
							(yield* client.getPrompt({ name: "Explain" }, { source: "host" }))
								._tag,
							"Completed",
						)
						assert.equal(fixture.state.calls, 1)
					}),
				),
			)
		} finally {
			await fixture.close()
		}
	})
}

test("standard initialize omits input capabilities without server-initiated handlers", async () => {
	const fixture = await service()
	try {
		await using runtime = ManagedRuntime.make(fixture.layers)
		await runtime.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* fixture.prepare
					yield* fixture.connect("standard", {
						capabilities: {
							elicitation: { form: {} },
							roots: { listChanged: true },
							experimental: { "example/presentation": {} },
						},
						inputs: {
							capabilities: { sampling: {} },
							handle: () =>
								Effect.fail(
									new Client.ClientError({
										reason: "InputUnavailable",
										issue: "Only the MRTR input bridge is installed",
									}),
								),
						},
					})
					assert.deepEqual(fixture.state.clientCapabilities, {
						experimental: { "example/presentation": {} },
					})
					assert.equal(fixture.state.calls, 0)
				}),
			),
		)
	} finally {
		await fixture.close()
	}
})

test("OpenBot connections never fall back to initialize and standard protection remains an authorization challenge", async () => {
	const fixture = await service()
	try {
		await using runtime = ManagedRuntime.make(fixture.layers)
		await runtime.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* fixture.prepare
					const failed = yield* fixture.connect("openbot").pipe(Effect.flip)
					assert.ok(failed instanceof Client.ClientError)
					assert.equal(fixture.methods.includes("initialize"), false)
					fixture.state.protected = true
					const protectedResult = yield* fixture.connect().pipe(Effect.flip)
					assert.ok(protectedResult instanceof Client.AuthorizationRequired)
					assert.equal(
						protectedResult.resourceMetadataUrl,
						fixture.ipOrigin + "/resource",
					)
					assert.equal(fixture.state.calls, 0)
				}),
			),
		)
	} finally {
		await fixture.close()
	}
})

test("malformed initialize cannot become a successful standard connection", async () => {
	const fixture = await service()
	fixture.state.malformed = true
	try {
		await using runtime = ManagedRuntime.make(fixture.layers)
		await runtime.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* fixture.prepare
					const failed = yield* fixture.connect().pipe(Effect.flip)
					assert.ok(failed instanceof Client.ClientError)
					assert.equal(fixture.methods.includes("tools/list"), false)
				}),
			),
		)
	} finally {
		await fixture.close()
	}
})
