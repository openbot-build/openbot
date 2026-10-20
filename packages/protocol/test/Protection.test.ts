import { Array as EffectArray, Effect, Layer, Redacted, Schema } from "effect"
import assert from "node:assert/strict"
import {
	PublisherProtection,
	McpPublisher,
	Authorization,
	Document,
	Protection,
} from "@openbot-build/protocol"
import { test } from "node:test"
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"

import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai"
import { HttpRouter } from "effect/http"

test("Protected publisher checks real identity, scopes and audience before it filters lists or runs tools", async () => {
	const origin = "https://notes.example"
	const resource = origin + "/mcp"
	const issuer = "https://accounts.example"
	let calls = 0
	const tools = Toolkit.make(
		...["AliceNote", "BobNote"].map((name) =>
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
	const verification = Layer.succeed(Protection.TokenVerifier, {
		verify: (token) => {
			const value = Redacted.value(token)
			if (!["alice", "bob", "expired", "audience", "scope"].includes(value))
				return Effect.fail(
					new Protection.TokenRejected({
						reason: "Invalid",
					}),
				)
			return Effect.succeed({
				subject: value,
				issuer,
				audiences: [value === "audience" ? origin + "/other" : resource],
				expiresAt: value === "expired" ? 1 : Date.now() + 60000,
				scopes: value === "scope" ? [] : ["notes"],
			})
		},
	})
	const policy = Layer.succeed(Protection.AccessPolicy, {
		check: (identity, operation) =>
			operation.method !== "tools/call" ||
			operation.target ===
				(identity.subject === "alice" ? "AliceNote" : "BobNote")
				? Effect.void
				: Effect.fail(
						new Protection.AccessDenied({
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
		publication: {
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
		},
		protection: {
			metadataUrl: origin + "/.well-known/oauth-protected-resource/mcp",
			authorizationServers: [issuer],
			scopes: ["notes"],
		},
		register: registration,
	})
	const app = HttpRouter.toWebHandler(
		layer.pipe(Layer.provide(Layer.merge(verification, policy))),
		{ disableLogger: true },
	)
	let clients: ReadonlyArray<Client> = []
	const verifierRequired: Protection.TokenVerifier extends Layer.Services<
		typeof layer
	>
		? true
		: false = true
	assert.ok(verifierRequired)
	try {
		assert.equal((await app.handler(new Request(origin + "/card"))).status, 200)
		const prm = await app.handler(
			new Request(origin + "/.well-known/oauth-protected-resource/mcp"),
		)
		assert.equal(
			(
				await Effect.runPromise(
					Authorization.ResourceMetadata.decode(await prm.json()),
				)
			).resource,
			resource,
		)
		for (const token of ["", "invalid", "expired", "audience", "scope"]) {
			const response = await app.handler(
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
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "tools/call",
						params: {
							name: "AliceNote",
							arguments: {},
						},
					}),
				}),
			)
			assert.equal(response.status, token === "scope" ? 403 : 401)
			assert.match(
				response.headers.get("www-authenticate") ?? "",
				/resource_metadata=/,
			)
		}
		assert.equal(calls, 0)
		for (const account of ["alice", "bob"]) {
			const client = new Client(
				{ name: "independent", version: "1.0.0" },
				{
					versionNegotiation: {
						mode: {
							pin: Document.protocolVersion,
						},
					},
					inputRequired: { autoFulfill: false },
				},
			)
			clients = EffectArray.append(clients, client)
			await client.connect(
				new StreamableHTTPClientTransport(new URL(resource), {
					requestInit: {
						headers: {
							authorization: "Bearer " + account,
						},
					},
					fetch: (input, init) => app.handler(new Request(input, init)),
				}),
			)
			const list = await client.listTools()
			assert.deepEqual(
				list.tools.map((tool) => tool.name),
				[account === "alice" ? "AliceNote" : "BobNote"],
			)
			assert.equal(list["cacheScope"], "private")
			const result = await client.callTool({
				name: list.tools[0]?.name ?? "",
				arguments: {},
			})
			assert.deepEqual(result.structuredContent, {
				subject: account,
			})
			const before: number = calls
			const denied = await app.handler(
				new Request(resource, {
					method: "POST",
					headers: {
						authorization: "Bearer " + account,
						"content-type": "application/json",
						accept: "application/json, text/event-stream",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 3,
						method: "tools/call",
						params: {
							name: account === "alice" ? "BobNote" : "AliceNote",
							arguments: {},
						},
					}),
				}),
			)
			assert.equal(denied.status, 403)
			assert.equal(calls, before)
		}
		assert.equal(calls, 2)
	} finally {
		await Promise.all(clients.map((client) => client.close()))
		await app.dispose()
	}
})
