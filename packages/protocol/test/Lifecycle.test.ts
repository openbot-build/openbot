// Tests are entry points, so they provide their own Layers.
// @effect-diagnostics strictEffectProvide:off
import {
	CatalogDiscovery,
	MemoryStore,
	MemoryIndex,
	AppConnections,
	McpClient,
	Index,
	Discovery,
	Document,
	App,
	Store,
} from "@openbot-build/protocol"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { assert, it } from "@effect/vitest"
import {
	Effect,
	Fiber,
	Layer,
	Redacted,
	Schema,
	Scope,
	Match,
	Option,
} from "effect"
import * as Mcp from "@modelcontextprotocol/client"
import { startHttps } from "./Fixture.ts"

// Build the services to test real HTTP cancellation and lifecycle storage
// failures. The tests use it.live, because they talk to a real HTTPS server.

const Request = Schema.Struct({
	id: Schema.optional(Schema.Union([Schema.String, Schema.Finite])),
	method: Schema.String,
	params: Schema.optional(Schema.JsonObject),
})
const service = async () => {
	let card: Document.ServerCard
	let started!: () => void
	const hanging = new Promise<void>((resolve) => {
		started = resolve
	})
	let closed!: () => void
	const released = new Promise<void>((resolve) => {
		closed = resolve
	})
	let reads = 0
	const fixture = await startHttps((req, res) => {
		if (req.url === "/card") {
			res.writeHead(200, {
				"content-type": Document.cardMediaType,
			})
			res.end(JSON.stringify(card))
			return
		}
		let body = ""
		req.setEncoding("utf8")
		req.on("data", (part: string) => {
			body += part
		})
		req.on("end", () => {
			reads++
			const request = Schema.decodeSync(Schema.fromJsonString(Request))(body)
			const reply = (value: object) => {
				res.writeHead(200, {
					"content-type": "application/json",
				})
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: request.id,
						result: {
							resultType: "complete",
							...value,
							_meta: {
								[Mcp.SERVER_INFO_META_KEY]: {
									name: "lifecycle-service",
									version: "1.0.0",
								},
							},
						},
					}),
				)
			}
			if (request.method === "server/discover")
				reply({
					supportedVersions: [Document.protocolVersion],
					capabilities: { tools: {} },
				})
			else if (request.method === "tools/list")
				reply({
					tools: [
						{
							name: "Hang",
							inputSchema: {
								type: "object",
							},
							annotations: {
								readOnlyHint: true,
							},
						},
					],
					ttlMs: 0,
					cacheScope: "private",
				})
			else if (request.method === "tools/call") {
				res.writeHead(200, {
					"content-type": "text/event-stream",
				})
				res.write(": alive\n\n")
				res.on("close", closed)
				started()
			} else {
				res.writeHead(400)
				res.end()
			}
		})
	})
	card = {
		$schema: Document.cardSchemaUrl,
		name: "example.test/lifecycle",
		version: "1.0.0",
		description: "Before",
		remotes: [
			{
				type: "streamable-http",
				url: fixture.ipOrigin + "/mcp",
				supportedProtocolVersions: [Document.protocolVersion],
			},
		],
	}
	const network = NodeHttpServer.layerUserNetwork({
		owner: "alice",
		allowedOrigins: [fixture.ipOrigin],
		ca: fixture.ca,
		allowAddress: (address) => address === "127.0.0.1",
	})
	const layers = Layer.mergeAll(
		network,
		CatalogDiscovery.layer().pipe(Layer.provide(network)),
		MemoryStore.layer,
		MemoryStore.layerCredentials,
		MemoryIndex.layer,
		AppConnections.layerConnectionScopes,
		McpClient.layerPolicy(() => Effect.void),
	)
	const key = { owner: "alice", connectionId: "notes" }
	const connection: Store.UserConnection = {
		...key,
		cardUrl: fixture.ipOrigin + "/card",
		endpoint: fixture.ipOrigin + "/mcp",
		remoteIndex: 0,
		configuration: Redacted.make({}),
		headers: Redacted.make({}),
		state: "Enabled",
		authorization: { _tag: "Unprotected" },
	}
	return {
		...fixture,
		layers,
		key,
		connection,
		get card() {
			return card
		},
		setCard: (value: Document.ServerCard) => {
			card = value
		},
		hanging,
		released,
		reads: () => reads,
	}
}
// The service stops when the test ends.
const openService = Effect.acquireRelease(
	Effect.promise(() => service()),
	(fixture) => Effect.promise(() => fixture.close()),
)
it.live(
	"remove stops new calls and real running I/O, keeps other owners and public entries, and resumes failed cleanup",
	() =>
		Effect.gen(function* () {
			const fixture = yield* openService
			yield* Effect.scoped(
				Effect.gen(function* () {
					const store = yield* Store.AppStore
					yield* store.save({
						app: {
							cardUrl: fixture.connection.cardUrl,
							card: fixture.card,
							sources: [],
						},
						connection: fixture.connection,
					})
					const bob = {
						...fixture.connection,
						owner: "bob",
					}
					yield* store.save({
						app: {
							cardUrl: fixture.connection.cardUrl,
							card: fixture.card,
							sources: [],
						},
						connection: bob,
					})
					const index = yield* Index.IndexStore
					yield* index.upsert({
						cardUrl: fixture.connection.cardUrl,
						card: fixture.card,
						checkedAt: 0,
						validators: {},
						evidence: [
							{
								publisherUrl: fixture.ipOrigin,
								catalogUrl: fixture.ipOrigin + "/catalog",
								cardUrl: fixture.connection.cardUrl,
								association: "CardOrigin",
							},
						],
					})
					const client = yield* McpClient.open({
						key: fixture.key,
						clientInfo: {
							name: "test",
							version: "1.0.0",
						},
					})
					const request = yield* Effect.forkChild(
						client.callTool(
							{ name: "Hang" },
							{
								source: "host",
								readOnly: true,
							},
						),
					)
					yield* Effect.promise(() => fixture.hanging)
					const credentials = yield* Store.CredentialStore
					const failCleanup = Store.CredentialStore.of({
						...credentials,
						deleteConnection: () =>
							Effect.fail(
								new Store.StoreError({
									reason: "Unavailable",
									operation: "deleteConnection",
								}),
							),
					})
					const failed = yield* Effect.result(
						AppConnections.remove(fixture.key).pipe(
							Effect.provideService(Store.CredentialStore, failCleanup),
						),
					)
					assert.strictEqual(failed._tag, "Failure")
					Match.value(failed).pipe(
						Match.tag("Failure", (failed) => {
							assert.strictEqual(failed.failure._tag, "CleanupPending")
						}),
						Match.orElse(() => undefined),
					)
					assert.strictEqual(
						(yield* store.get(fixture.key)).state,
						"CleanupPending",
					)
					yield* Effect.promise(() => fixture.released)
					yield* Fiber.await(request)
					const before = fixture.reads()
					assert.strictEqual(
						(yield* Effect.result(AppConnections.usable(fixture.key)))._tag,
						"Failure",
					)
					assert.strictEqual(
						(yield* Effect.result(
							client.callTool(
								{
									name: "Hang",
								},
								{
									source: "app",
								},
							),
						))._tag,
						"Failure",
					)
					assert.strictEqual(fixture.reads(), before)
					assert.strictEqual((yield* store.get(bob)).state, "Enabled")
					assert.strictEqual(
						(yield* index.get(fixture.connection.cardUrl))._tag,
						"Some",
					)
					assert.strictEqual(
						(yield* AppConnections.remove(fixture.key))._tag,
						"Removed",
					)
					assert.strictEqual(
						(yield* Effect.result(store.get(fixture.key)))._tag,
						"Failure",
					)
					assert.strictEqual((yield* store.get(bob)).state, "Enabled")
				}),
			).pipe(
				Effect.provide(
					fixture.layers.pipe(
						Layer.provideMerge([CatalogDiscovery.layerRules]),
					),
				),
			)
		}),
)
it.live(
	"description updates keep authorization, but endpoint, issuer and scope changes pause it until explicit confirmation",
	() =>
		Effect.gen(function* () {
			const fixture = yield* openService
			yield* Effect.scoped(
				Effect.gen(function* () {
					const store = yield* Store.AppStore
					const credentials = yield* Store.CredentialStore
					const binding = {
						...fixture.key,
						resource: fixture.connection.endpoint,
						issuer: fixture.ipOrigin,
					}
					const reference = yield* credentials.put({
						binding,
						accessToken: Redacted.make("old-token"),
						scopes: ["notes"],
					})
					yield* store.save({
						app: {
							cardUrl: fixture.connection.cardUrl,
							card: fixture.card,
							sources: [],
						},
						connection: {
							...fixture.connection,
							authorization: {
								_tag: "Authorized",
								binding,
								credentialRef: reference,
								scopes: ["notes"],
							},
						},
					})
					fixture.setCard({
						...fixture.card,
						description: "After",
					})
					const discovery = yield* Discovery.Discovery
					let candidate = yield* discovery.refreshCard(
						fixture.connection.cardUrl,
					)
					assert.strictEqual(
						(yield* AppConnections.revalidate({
							key: fixture.key,
							candidate,
							confirmed: false,
							authorization: Option.some({
								issuer: fixture.ipOrigin,
								scopes: ["notes"],
							}),
						}))._tag,
						"DescriptionUpdated",
					)
					assert.strictEqual(
						(yield* store.get(fixture.key)).authorization._tag,
						"Authorized",
					)
					const active = yield* App.ConnectionScopes
					const parent = yield* Effect.scope
					const scope = yield* Scope.fork(parent)
					let finalized = false
					yield* Scope.addFinalizer(
						scope,
						Effect.sync(() => {
							finalized = true
						}),
					)
					yield* active.register({
						key: fixture.key,
						scope,
					})
					fixture.setCard({
						...fixture.card,
						remotes: [
							{
								type: "streamable-http",
								url: fixture.ipOrigin + "/new-mcp",
								supportedProtocolVersions: [Document.protocolVersion],
							},
						],
					})
					candidate = yield* discovery.refreshCard(fixture.connection.cardUrl)
					assert.strictEqual(
						(yield* AppConnections.revalidate({
							key: fixture.key,
							candidate,
							confirmed: false,
							authorization: Option.some({
								issuer: fixture.ipOrigin + "/new-issuer",
								scopes: ["notes", "write"],
							}),
						}))._tag,
						"NeedsRevalidation",
					)
					assert.strictEqual(
						(yield* store.get(fixture.key)).state,
						"NeedsRevalidation",
					)
					assert.strictEqual(finalized, true)
					const before = fixture.reads()
					assert.strictEqual(
						(yield* Effect.result(
							McpClient.open({
								key: fixture.key,
								clientInfo: {
									name: "test",
									version: "1.0.0",
								},
							}),
						))._tag,
						"Failure",
					)
					assert.strictEqual(fixture.reads(), before)
					const confirmed = yield* AppConnections.revalidate({
						key: fixture.key,
						candidate,
						confirmed: true,
						authorization: Option.some({
							issuer: fixture.ipOrigin + "/new-issuer",
							scopes: ["notes", "write"],
						}),
					})
					assert.strictEqual(confirmed._tag, "Revalidated")
					assert.strictEqual(
						(yield* store.get(fixture.key)).authorization._tag,
						"PendingAuthorization",
					)
					assert.strictEqual(
						(yield* Effect.result(
							credentials.get({
								binding,
								reference,
							}),
						))._tag,
						"Failure",
					)
					assert.strictEqual(
						(yield* Effect.result(
							McpClient.open({
								key: fixture.key,
								clientInfo: {
									name: "test",
									version: "1.0.0",
								},
							}),
						))._tag,
						"Failure",
					)
					assert.strictEqual(fixture.reads(), before)
					// Changing only the issuer or scopes also pauses a currently authorized connection.
					for (const change of [
						{
							issuer: fixture.ipOrigin + "/other-issuer",
							scopes: ["notes"],
						},
						{
							issuer: fixture.ipOrigin,
							scopes: ["notes", "write"],
						},
					]) {
						const key = {
							owner: "alice",
							connectionId: change.scopes.length === 1 ? "issuer" : "scopes",
						}
						const endpoint = fixture.ipOrigin + "/new-mcp"
						const bound = {
							...key,
							resource: endpoint,
							issuer: fixture.ipOrigin,
						}
						const credentialRef = yield* credentials.put({
							binding: bound,
							accessToken: Redacted.make("separate-old-token"),
							scopes: ["notes"],
						})
						yield* store.save({
							app: {
								cardUrl: fixture.connection.cardUrl,
								card: fixture.card,
								sources: [],
							},
							connection: {
								...fixture.connection,
								...key,
								endpoint,
								authorization: {
									_tag: "Authorized",
									binding: bound,
									credentialRef,
									scopes: ["notes"],
								},
							},
						})
						assert.strictEqual(
							(yield* AppConnections.revalidate({
								key,
								candidate,
								confirmed: false,
								authorization: Option.some(change),
							}))._tag,
							"NeedsRevalidation",
						)
						assert.strictEqual(
							(yield* store.get(key)).state,
							"NeedsRevalidation",
						)
						assert.strictEqual(
							(yield* Effect.result(
								McpClient.open({
									key,
									clientInfo: {
										name: "test",
										version: "1",
									},
								}),
							))._tag,
							"Failure",
						)
						assert.strictEqual(fixture.reads(), before)
					}
				}),
			).pipe(
				Effect.provide(
					fixture.layers.pipe(
						Layer.provideMerge([CatalogDiscovery.layerRules]),
					),
				),
			)
		}),
)

it.live(
	"revalidation ignores the key order of configuration and variables, and the order and duplicates of scopes",
	() =>
		Effect.gen(function* () {
			const fixture = yield* openService
			const original = {
				...fixture.card,
				remotes: [
					{
						...fixture.card.remotes![0]!,
						variables: {
							account: { default: "one" },
							mode: { default: "read" },
						},
						headers: [
							{ name: "X-Account", value: "one" },
							{ name: "X-Mode", value: "read" },
						],
					},
				],
			}
			fixture.setCard(original)
			yield* Effect.scoped(
				Effect.gen(function* () {
					const store = yield* Store.AppStore
					const binding = {
						...fixture.key,
						resource: fixture.connection.endpoint,
						issuer: fixture.ipOrigin,
					}
					const credentials = yield* Store.CredentialStore
					const credentialRef = yield* credentials.put({
						binding,
						accessToken: Redacted.make("token"),
						scopes: ["notes", "write"],
					})
					yield* store.save({
						app: {
							cardUrl: fixture.connection.cardUrl,
							card: original,
							sources: [],
						},
						connection: {
							...fixture.connection,
							configuration: Redacted.make({ account: "one", mode: "read" }),
							headers: Redacted.make({
								"X-Mode": "read",
								"X-Account": "one",
							}),
							authorization: {
								_tag: "Authorized",
								binding,
								credentialRef,
								scopes: ["notes", "write"],
							},
						},
					})
					fixture.setCard({
						...original,
						remotes: [
							{
								...original.remotes[0]!,
								variables: {
									mode: { default: "read" },
									account: { default: "one" },
								},
							},
						],
					})
					const discovery = yield* Discovery.Discovery
					const candidate = yield* discovery.refreshCard(
						fixture.connection.cardUrl,
					)
					const options = {
						key: fixture.key,
						candidate,
						confirmed: false,
						values: { mode: "read", account: "one" },
						authorization: Option.some({
							issuer: fixture.ipOrigin,
							scopes: ["write", "notes", "write"],
						}),
					}
					assert.strictEqual(
						(yield* AppConnections.revalidate(options))._tag,
						"DescriptionUpdated",
					)
					assert.strictEqual(
						(yield* store.get(fixture.key)).authorization._tag,
						"Authorized",
					)
					assert.strictEqual(
						(yield* AppConnections.revalidate({
							...options,
							values: { mode: "write", account: "one" },
						}))._tag,
						"NeedsRevalidation",
					)
				}),
			).pipe(
				Effect.provide(
					fixture.layers.pipe(
						Layer.provideMerge([CatalogDiscovery.layerRules]),
					),
				),
			)
		}),
)
